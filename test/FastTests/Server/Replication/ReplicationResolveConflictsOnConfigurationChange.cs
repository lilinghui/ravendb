﻿using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using FastTests.Server.Basic.Entities;
using Raven.Client.Documents;
using Raven.Client.Documents.Replication;
using Raven.Client.Server;
using Raven.Client.Server.Commands;
using Raven.Client.Server.Operations;
using Raven.Server.Web.System;
using Raven.Tests.Core.Utils.Entities;
using Xunit;

namespace FastTests.Server.Replication
{
    public class ReplicationResolveConflictsOnConfigurationChange : ReplicationTestsBase
    {

        public async Task GenerateConflicts(DocumentStore store1, DocumentStore store2, string id = "foo/bar")
        {
            using (var session = store1.OpenSession())
            {
                session.Store(new User
                {
                    Name = "Store1"
                }, id);
                session.SaveChanges();
            }
            using (var session = store2.OpenSession())
            {
                session.Store(new User
                {
                    Name = "Store2"
                }, id);
                session.SaveChanges();
            }
            await SetupReplicationAsync(store1,store2);
            await SetupReplicationAsync(store2,store1);

            Assert.Equal(2, WaitUntilHasConflict(store1, id).Results.Length);
            Assert.Equal(2, WaitUntilHasConflict(store2, id).Results.Length);
        }

        [Fact]
        public async Task ResolveWhenScriptAdded()
        {
            using (var store1 = GetDocumentStore())
            using (var store2 = GetDocumentStore())
            {
                await GenerateConflicts(store1, store2);
                var config = new ConflictSolver
                {
                    ResolveByCollection = new Dictionary<string, ScriptResolver>
                    {
                        {
                            "Users", new ScriptResolver
                            {
                                Script = "return {'Name':'Resolved'}"
                            }
                        }
                    }
                };
                await SetupReplicationAsync(store1, config, store2);

                Assert.True(WaitForDocument<User>(store1, "foo/bar", u => u.Name == "Resolved"));
                Assert.True(WaitForDocument<User>(store2, "foo/bar", u => u.Name == "Resolved"));
            }
        }

        [Fact]
        public async Task ResolveWhenChangeToLatest()
        {
            using (var store1 = GetDocumentStore())
            using (var store2 = GetDocumentStore())
            {
                await GenerateConflicts(store1, store2);

                await SetReplicationConflictResolutionAsync(store1, StraightforwardConflictResolution.ResolveToLatest);

                Assert.True(WaitForDocument<User>(store1, "foo/bar", u => u.Name == "Store2"));
                Assert.True(WaitForDocument<User>(store2, "foo/bar", u => u.Name == "Store2"));
            }
        }

        [Fact]
        public async Task ResolveWhenSettingDatabaseResolver()
        {
            using (var store1 = GetDocumentStore())
            using (var store2 = GetDocumentStore())
            {
                await GenerateConflicts(store1, store2);
                var storage1 = Server.ServerStore.DatabasesLandlord.TryGetOrCreateResourceStore(store1.Database).Result;

                var config = new ConflictSolver
                {
                    DatabaseResolverId = storage1.DbId.ToString()
                };
                await SetupReplicationAsync(store1, config, store2);

                Assert.True(WaitForDocument<User>(store1, "foo/bar", u => u.Name == "Store1"));
                Assert.True(WaitForDocument<User>(store2, "foo/bar", u => u.Name == "Store1"));
            }
        }

        private async Task RemoveReplicationFrom(DocumentStore store)
        {
            var tasks = OngoingTasksHandler.GetOngoingTasksFor(store.Database, Server.ServerStore);
            foreach (var replication in tasks.OngoingTasksList.OfType<OngoingTaskReplication>())
            {
                await DeleteOngoingTask(store, replication.TaskId, OngoingTaskType.Replication);
            }
        }
        

        [Fact]
        public async Task ResolveManyConflicts()
        {
            using (var store1 = GetDocumentStore())
            using (var store2 = GetDocumentStore())
            {
                await GenerateConflicts(store1, store2, "users/1");

                await RemoveReplicationFrom(store1);
                await RemoveReplicationFrom(store2);
                await GenerateConflicts(store1, store2, "users/2");
                var storage1 = await Server.ServerStore.DatabasesLandlord.TryGetOrCreateResourceStore(store1.Database);
                await UpdateConflictResolver(store1, storage1.DbId.ToString());

                Assert.True(WaitForDocument<User>(store1, "users/1", u => u.Name == "Store1"));
                Assert.True(WaitForDocument<User>(store2, "users/1", u => u.Name == "Store1"));
                Assert.True(WaitForDocument<User>(store1, "users/2", u => u.Name == "Store1"));
                Assert.True(WaitForDocument<User>(store2, "users/2", u => u.Name == "Store1"));
            }
        }
    }
}