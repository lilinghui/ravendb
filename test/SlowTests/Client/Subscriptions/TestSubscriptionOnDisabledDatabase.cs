﻿using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using FastTests;
using Raven.Client.Documents.Subscriptions;
using Raven.Client.Exceptions.Database;
using Raven.Client.Server.Operations;
using Raven.Tests.Core.Utils.Entities;
using Xunit;

namespace SlowTests.Client.Subscriptions
{
    public class TestSubscriptionOnDisabledDatabase:RavenTestBase
    {
        private readonly TimeSpan _reasonableWaitTime = Debugger.IsAttached ? TimeSpan.FromSeconds(60 * 10) : TimeSpan.FromSeconds(6);

        [Fact]
        public async Task Run()
        {

            using (var store = GetDocumentStore())
            {
                store.Subscriptions.Create(new SubscriptionCreationOptions<User>()
                {
                    Name = "Subs1"
                });

                var subscription = store.Subscriptions.Open<User>(new SubscriptionConnectionOptions("Subs1"));
                List<string> names = new List<string>();
                var subscriptionTask = subscription.Run(x =>
                {
                    foreach (var item in x.Items)
                    {
                        names.Add(item.Result.Name);
                    }
                });


                using (var session = store.OpenSession())
                {
                    for (var i = 0; i < 30; i++)
                        session.Store(new User { Name = i.ToString() });
                    session.SaveChanges();
                }

                var mre = new ManualResetEvent(false);

                subscription.AfterAcknowledgment += batch =>
                {
                    if (names.Count != 0 && names.Count % 30 == 0)
                        mre.Set();
                    return Task.CompletedTask;
                };

                Assert.True(mre.WaitOne(_reasonableWaitTime));
                mre.Reset();

                store.Admin.Server.Send(new DisableDatabaseToggleOperation(store.Database, true));

                await Assert.ThrowsAsync<DatabaseDisabledException>(async () => await subscriptionTask);

                store.Admin.Server.Send(new DisableDatabaseToggleOperation(store.Database, false));


                subscription = store.Subscriptions.Open<User>(new SubscriptionConnectionOptions("Subs1"));

                subscription.AfterAcknowledgment += batch =>
                {
                    if (names.Count != 0 && names.Count % 30 == 0)
                        mre.Set();
                    return Task.CompletedTask;
                };

#pragma warning disable 4014
                subscription.Run(x =>
#pragma warning restore 4014
                {
                    foreach (var item in x.Items)
                    {
                        names.Add(item.Result.Name);
                    }
                });

                using (var session = store.OpenSession())
                {
                    for (var i = 0; i < 30; i++)
                        session.Store(new User { Name = i.ToString() });
                    session.SaveChanges();
                }
                Assert.True(mre.WaitOne(_reasonableWaitTime));
            }
        }
    }
}