import app = require("durandal/app");
import viewModelBase = require("viewmodels/viewModelBase");
import patchDocument = require("models/database/patch/patchDocument");
import aceEditorBindingHandler = require("common/bindingHelpers/aceEditorBindingHandler");
import getDatabaseStatsCommand = require("commands/resources/getDatabaseStatsCommand");
import collectionsStats = require("models/database/documents/collectionsStats");
import getCollectionsStatsCommand = require("commands/database/documents/getCollectionsStatsCommand");
import collection = require("models/database/documents/collection");
import document = require("models/database/documents/document");
import jsonUtil = require("common/jsonUtil");
import database = require("models/resources/database");
import messagePublisher = require("common/messagePublisher");
import appUrl = require("common/appUrl");
import queryIndexCommand = require("commands/database/query/queryIndexCommand");
import getDocumentWithMetadataCommand = require("commands/database/documents/getDocumentWithMetadataCommand");
import getDocumentsMetadataByIDPrefixCommand = require("commands/database/documents/getDocumentsMetadataByIDPrefixCommand");
import savePatchCommand = require('commands/database/patch/savePatchCommand');
import patchByQueryCommand = require("commands/database/patch/patchByQueryCommand");
import patchByCollectionCommand = require("commands/database/patch/patchByCollectionCommand");
import documentMetadata = require("models/database/documents/documentMetadata");
import getIndexDefinitionCommand = require("commands/database/index/getIndexDefinitionCommand");
import queryUtil = require("common/queryUtil");
import getPatchesCommand = require('commands/database/patch/getPatchesCommand');
import eventsCollector = require("common/eventsCollector");
import notificationCenter = require("common/notifications/notificationCenter");
import genUtils = require("common/generalUtils");
import queryCriteria = require("models/database/query/queryCriteria");
import virtualGridController = require("widgets/virtualGrid/virtualGridController");
import documentBasedColumnsProvider = require("widgets/virtualGrid/columns/providers/documentBasedColumnsProvider");
import executeBulkDocsCommand = require("commands/database/documents/executeBulkDocsCommand");
import popoverUtils = require("common/popoverUtils");
import deleteDocumentsCommand = require("commands/database/documents/deleteDocumentsCommand");
import columnPreviewPlugin = require("widgets/virtualGrid/columnPreviewPlugin");
import columnsSelector = require("viewmodels/partial/columnsSelector");
import documentPropertyProvider = require("common/helpers/database/documentPropertyProvider");
import textColumn = require("widgets/virtualGrid/columns/textColumn");
import virtualColumn = require("widgets/virtualGrid/columns/virtualColumn");


type fetcherType = (skip: number, take: number, previewCols: string[], fullCols: string[]) => JQueryPromise<pagedResult<document>>;

class patchList {

    previewItem = ko.observable<patchDocument>();

    private allPatches = ko.observableArray<patchDocument>([]);

    private readonly useHandler: (patch: patchDocument) => void;
    private readonly removeHandler: (patch: patchDocument) => void;

    hasAnySavedPatch = ko.pureComputed(() => this.allPatches().length > 0);

    previewCode = ko.pureComputed(() => {
        const item = this.previewItem();
        if (!item) {
            return "";
        }

        return Prism.highlight(item.script(), (Prism.languages as any).javascript);
    });

    constructor(useHandler: (patch: patchDocument) => void, removeHandler: (patch: patchDocument) => void) {
        _.bindAll(this, ...["previewPatch", "removePatch", "usePatch"] as Array<keyof this>);
        this.useHandler = useHandler;
        this.removeHandler = removeHandler;
    }

    filteredPatches = ko.pureComputed(() => {
        let text = this.filters.searchText();

        if (!text) {
            return this.allPatches();
        }

        text = text.toLowerCase();

        return this.allPatches().filter(x => x.name().toLowerCase().includes(text));
    });

    filters = {
        searchText: ko.observable<string>()
    }

    previewPatch(item: patchDocument) {
        this.previewItem(item);
    }

    usePatch() {
        this.useHandler(this.previewItem());
    }

    removePatch(item: patchDocument) {
        if (this.previewItem() === item) {
            this.previewItem(null);
        }
        this.removeHandler(item);
    }

    loadAll(db: database) {
        return new getPatchesCommand(db)
            .execute()
            .done((patches: patchDocument[]) => {
                this.allPatches(patches);

                if (this.filteredPatches().length) {
                    this.previewItem(this.filteredPatches()[0]);
                }
            });
    }
}


class patch extends viewModelBase {

    inSaveMode = ko.observable<boolean>();
    patchSaveName = ko.observable<string>();

    spinners = {
        save: ko.observable<boolean>(false)
    }

    gridController = ko.observable<virtualGridController<document>>(); //TODO: column preview, custom columns?
    private documentsProvider: documentBasedColumnsProvider;
    private columnPreview = new columnPreviewPlugin<document>();
    columnsSelector = new columnsSelector<document>(); //TODO: refesh on selected item changed
    private fullDocumentsProvider: documentPropertyProvider;
    private fetcher = ko.observable<fetcherType>();

    patchDocument = ko.observable<patchDocument>(patchDocument.empty());

    indexNames = ko.observableArray<string>();
    indexFields = ko.observableArray<string>();
    collections = ko.observableArray<collection>([]);

    isDocumentMode: KnockoutComputed<boolean>;
    isCollectionMode: KnockoutComputed<boolean>;
    isIndexMode: KnockoutComputed<boolean>;

    documentIdSearchResults = ko.observableArray<string>();

    runPatchValidationGroup: KnockoutValidationGroup;
    runQueryValidationGroup: KnockoutValidationGroup;
    savePatchValidationGroup: KnockoutValidationGroup;

    savedPatches = new patchList(item => this.usePatch(item), item => this.removePatch(item));

    private hideSavePatchHandler = (e: Event) => {
        if ($(e.target).closest(".patch-save").length === 0) {
            this.inSaveMode(false);
        }
    }

    //TODO: implement: Data has changed. Your results may contain duplicates or non-current entries

    constructor() {
        super();
        aceEditorBindingHandler.install();

        this.initValidation();

        this.bindToCurrentInstance("usePatchOption", "useIndex", "useCollection");
        this.initObservables();
    }

    private initValidation() {
        const doc = this.patchDocument();

        doc.script.extend({
            required: true
        });

        doc.selectedItem.extend({
            required: true
        });

        this.patchSaveName.extend({
            required: true
        });

        this.runPatchValidationGroup = ko.validatedObservable({
            script: doc.script,
            selectedItem: doc.selectedItem
        });
        this.runQueryValidationGroup = ko.validatedObservable({
            selectedItem: doc.selectedItem
        });

        this.savePatchValidationGroup = ko.validatedObservable({
            patchSaveName: this.patchSaveName
        });
    }

    private initObservables() {
        this.isDocumentMode = ko.pureComputed(() => this.patchDocument().patchOnOption() === "Document");
        this.isCollectionMode = ko.pureComputed(() => this.patchDocument().patchOnOption() === "Collection");
        this.isIndexMode = ko.pureComputed(() => this.patchDocument().patchOnOption() === "Index");

        this.patchDocument().selectedItem.throttle(250).subscribe(item => {
            if (this.patchDocument().patchOnOption() === "Document") {
                this.fetchDocumentIdAutocomplete(item);
            }
        });

        this.patchDocument().patchAll.subscribe((patchAll) => {
            this.documentsProvider.showRowSelectionCheckbox = !patchAll; //TODO: should we have to always set to true?

            //TODO: if has custom layout just toggle checkbox? 

            this.gridController().reset(true);
        });

        this.inSaveMode.subscribe(enabled => {
            const $input = $(".patch-save .form-control");
            if (enabled) {
                $input.show();
                window.addEventListener("click", this.hideSavePatchHandler, true);
            } else {
                this.savePatchValidationGroup.errors.showAllMessages(false);
                window.removeEventListener("click", this.hideSavePatchHandler, true);
                setTimeout(() => $input.hide(), 200);
            }
        });
    }

    activate(recentPatchHash?: string) {
        super.activate(recentPatchHash);
        this.updateHelpLink("QGGJR5");

        this.fullDocumentsProvider = new documentPropertyProvider(this.activeDatabase());

        return $.when<any>(this.fetchAllCollections(), this.fetchAllIndexes(), this.savedPatches.loadAll(this.activeDatabase()));
    }

    attached() {
        super.attached();

        const jsCode = Prism.highlight("this.NewProperty = this.OldProperty + myParameter;\r\n" +
            "delete this.UnwantedProperty;\r\n" +
            "this.Comments.RemoveWhere(function(comment){\r\n" +
            "  return comment.Spam;\r\n" +
            "});",
            (Prism.languages as any).javascript);

        $(".query-label small").popover({
            html: true,
            trigger: "hover",
            template: popoverUtils.longPopoverTemplate,
            container: 'body',
            content: '<p>Queries use Lucene syntax. Examples:</p><pre><span class="token keyword">Name</span>: Hi?berna*<br/><span class="token keyword">Count</span>: [0 TO 10]<br/><span class="token keyword">Title</span>: "RavenDb Queries 1010" <span class="token keyword">AND Price</span>: [10.99 TO *]</pre>'
        });

        $(".patch-title small").popover({
            html: true,
            trigger: "hover",
            container: "body",
            template: popoverUtils.longPopoverTemplate,
            content: `<p>Patch Scripts are written in JavaScript. <br />Examples: <pre>${jsCode}</pre></p>`
        });
    }

    compositionComplete() {
        super.compositionComplete();

        const grid = this.gridController();
        this.documentsProvider = new documentBasedColumnsProvider(this.activeDatabase(), this.collections().map(x => x.name), {
            showRowSelectionCheckbox: false,
            showSelectAllCheckbox: false
        });

        const fakeFetcher: fetcherType = () => $.Deferred<pagedResult<document>>().resolve({
            items: [],
            totalResultCount: 0
        });

        grid.headerVisible(true);

        const allColumnsProvider = (results: pagedResultWithAvailableColumns<document>) => {
            const selectedItem = this.patchDocument().selectedItem();
            if (!selectedItem || this.patchDocument().patchOnOption() === "Document" || !this.fetcher()) {
                return [];
            }

            switch (this.patchDocument().patchOnOption()) {
                case "Document":
                    return [];
                case "Index":
                    return documentBasedColumnsProvider.extractUniquePropertyNames(results);
                case "Collection":
                    return results.availableColumns;
            }
        }

        this.columnsSelector.init(grid, (s, t, previewCols, fullCols) => this.fetcher() ? this.fetcher()(s, t, previewCols, fullCols) : fakeFetcher(s, t, [], []),
            (w, r) => this.documentsProvider.findColumns(w, r),
            allColumnsProvider);

        this.columnPreview.install(".patch-grid", ".tooltip", (doc: document, column: virtualColumn, e: JQueryEventObject, onValue: (context: any) => void) => {
            if (column instanceof textColumn) {
                this.fullDocumentsProvider.resolvePropertyValue(doc, column, (v: any) => {
                    if (!_.isUndefined(v)) {
                        const json = JSON.stringify(v, null, 4);
                        const html = Prism.highlight(json, (Prism.languages as any).javascript);
                        onValue(html);    
                    }
                }, error => {
                    const html = Prism.highlight("Unable to generate column preview: " + error.toString(), (Prism.languages as any).javascript);
                    onValue(html);
                });
            }
        });

        this.fetcher.subscribe(() => grid.reset());
    }

    usePatchOption(option: patchOption) {
        this.fetcher(null);

        const patchDoc = this.patchDocument();
        patchDoc.selectedItem(null);
        patchDoc.patchOnOption(option);
        patchDoc.patchAll(option === "Index" || option === "Collection");

        if (option !== "Index") {
            patchDoc.query(null);
        }

        this.runPatchValidationGroup.errors.showAllMessages(false);
    }

    useIndex(indexName: string) {
        const patchDoc = this.patchDocument();
        patchDoc.selectedItem(indexName);
        patchDoc.patchAll(true);

        this.columnsSelector.reset();

        queryUtil.fetchIndexFields(this.activeDatabase(), indexName, this.indexFields);

        this.runQuery();
    }

    useCollection(collectionToUse: collection) {
        this.columnsSelector.reset();

        const fetcher = (skip: number, take: number, previewCols: string[], fullCols: string[]) => collectionToUse.fetchDocuments(skip, take, previewCols, fullCols);
        this.fetcher(fetcher);

        const patchDoc = this.patchDocument();
        patchDoc.selectedItem(collectionToUse.name);
        patchDoc.patchAll(true);
    }

    queryCompleter(editor: any, session: any, pos: AceAjax.Position, prefix: string, callback: (errors: any[], worldlist: { name: string; value: string; score: number; meta: string }[]) => void) {
        queryUtil.queryCompleter(this.indexFields, this.patchDocument().selectedIndex, this.activeDatabase, editor, session, pos, prefix, callback);
    }

    usePatch(item: patchDocument) {
        const patchDoc = this.patchDocument();

        //TODO: handle case when saved patch has collection which no longer exist, or index which is not available

        patchDoc.copyFrom(item);

        switch (patchDoc.patchOnOption()) {
            case "Index":
                this.useIndex(patchDoc.selectedItem());
                break;
            case "Collection":
                const matchedCollection = this.collections().find(x => x.name === patchDoc.selectedItem());
                if (matchedCollection) {
                    this.useCollection(matchedCollection);
                }
                break;
        }
    }

    removePatch(item: patchDocument) {
        this.confirmationMessage("Patch", `Are you sure you want to delete patch '${item.name()}'?`, ["Cancel", "Delete"])
            .done(result => {
                if (result.can) {
                    new deleteDocumentsCommand([item.getId()], this.activeDatabase())
                        .execute()
                        .done(() => {
                            messagePublisher.reportSuccess("Deleted patch " + item.name());
                            this.savedPatches.loadAll(this.activeDatabase());
                        })
                        .fail(response => messagePublisher.reportError("Failed to delete " + item.name(), response.responseText, response.statusText));
                }
            });
    }

    runQuery(): void {
        if (this.isValid(this.runQueryValidationGroup)) {
            const selectedIndex = this.patchDocument().selectedItem();
            if (selectedIndex) {
                const database = this.activeDatabase();
                const query = this.patchDocument().query();

                const resultsFetcher = (skip: number, take: number) => {
                    const criteria = queryCriteria.empty();
                    criteria.selectedIndex(selectedIndex);
                    criteria.queryText(query);

                    return new queryIndexCommand(database, skip, take, criteria)
                        .execute();
                };
                this.fetcher(resultsFetcher);
            }
        }
    }

    runPatch() {
        if (this.isValid(this.runPatchValidationGroup)) {

            const patchDoc = this.patchDocument();

            switch (patchDoc.patchOnOption()) {
            case "Document":
                this.patchOnDocuments([patchDoc.selectedItem()]);
                break;
            case "Index":
                if (patchDoc.patchAll()) {
                    this.patchOnIndex();
                } else {
                    const selectedIds = this.gridController().getSelectedItems().map(x => x.getId());
                    this.patchOnDocuments(selectedIds);
                }
                break;
            case "Collection":
                if (patchDoc.patchAll()) {
                    this.patchOnCollection();
                } else {
                    const selectedIds = this.gridController().getSelectedItems().map(x => x.getId());
                    this.patchOnDocuments(selectedIds);
                }
            }
        }
    }

    savePatch() {
        if (this.inSaveMode()) {
            eventsCollector.default.reportEvent("patch", "save");

            if (this.isValid(this.savePatchValidationGroup)) {
                this.spinners.save(true);
                new savePatchCommand(this.patchSaveName(), this.patchDocument(), this.activeDatabase())
                    .execute()
                    .always(() => this.spinners.save(false))
                    .done(() => {
                        this.inSaveMode(false);
                        this.patchSaveName("");
                        this.savePatchValidationGroup.errors.showAllMessages(false);
                        this.savedPatches.loadAll(this.activeDatabase());
                    });
            }
        } else {
            if (this.isValid(this.runPatchValidationGroup)) {
                this.inSaveMode(true);    
            }
        }
    }

    private patchOnDocuments(documentIds: Array<string>) {
        eventsCollector.default.reportEvent("patch", "run", "selected");
        const message = documentIds.length > 1 ? `Are you sure you want to apply this patch to ${documentIds.length} documents?` : 'Are you sure you want to patch document?';

        this.confirmationMessage("Patch", message, ["Cancel", "Patch"])
            .done(result => {
                if (result.can) {
                    const bulkDocs = documentIds.map(docId => ({
                        Key: docId,
                        Method: 'PATCH' as Raven.Server.Documents.Handlers.CommandType,
                        Patch: {
                            Script: this.patchDocument().script()
                        }
                    } as Raven.Server.Documents.Handlers.CommandData));

                    new executeBulkDocsCommand(bulkDocs, this.activeDatabase())
                        .execute()
                        .done(() => messagePublisher.reportSuccess("Patch completed"))
                        .fail((result: JQueryXHR) => messagePublisher.reportError("Unable to patch documents.",
                            result.responseText,
                            result.statusText));
                }
            });
    }

    private patchOnIndex() {
        eventsCollector.default.reportEvent("patch", "run", "index");
        const indexToPatch = this.patchDocument().selectedItem();
        const query = this.patchDocument().query();
        const message = `Are you sure you want to apply this patch to matching documents?`;

        this.confirmationMessage("Patch", message, ["Cancel", "Patch all"])
            .done(result => {
                if (result.can) {
                    const patch = {
                        Script: this.patchDocument().script()
                    } as Raven.Server.Documents.Patch.PatchRequest;

                    new patchByQueryCommand(indexToPatch, query, patch, this.activeDatabase())
                        .execute()
                        .done((operationIdDto) => {
                            notificationCenter.instance.openDetailsForOperationById(this.activeDatabase(), operationIdDto.OperationId);
                        });
                }
            });
    }

    private patchOnCollection() {
        eventsCollector.default.reportEvent("patch", "run", "collection");
        const collectionToPatch = this.patchDocument().selectedItem();
        const message = `Are you sure you want to apply this patch to all documents in '${collectionToPatch}' collection?`;

        this.confirmationMessage("Patch", message, ["Cancel", "Patch all"])
            .done(result => {
                if (result.can) {

                    const patch = {
                        Script: this.patchDocument().script()
                    } as Raven.Server.Documents.Patch.PatchRequest;

                    new patchByCollectionCommand(collectionToPatch, patch, this.activeDatabase())
                        .execute()
                        .done((operationIdDto) => {
                            notificationCenter.instance.openDetailsForOperationById(this.activeDatabase(), operationIdDto.OperationId);
                        });
                }
            });
    }

    private fetchDocumentIdAutocomplete(prefix: string) {
        if (prefix && prefix.length > 1) {
            new getDocumentsMetadataByIDPrefixCommand(prefix, 10, this.activeDatabase())
                .execute()
                .done(result => {
                    this.documentIdSearchResults(result.map(x => x["@metadata"]["@id"]));
                });
        } else {
            this.documentIdSearchResults([]);
        }
    }

    private fetchAllCollections(): JQueryPromise<collectionsStats> {
        return new getCollectionsStatsCommand(this.activeDatabase())
            .execute()
            .done((stats: collectionsStats) => {
                this.collections(stats.collections);
            });
    }

    private fetchAllIndexes(): JQueryPromise<Raven.Client.Documents.Operations.DatabaseStatistics> {
        return new getDatabaseStatsCommand(this.activeDatabase())
            .execute()
            .done((results) => {
                this.indexNames(results.Indexes.filter(x => x.Type === "Map").map(x => x.Name));
            });
    }

    /* TODO:
    
    savedPatches = ko.observableArray<patchDocument>();

    showDocumentsPreview: KnockoutObservable<boolean>;

    beforePatch: KnockoutComputed<string>;
    beforePatchDoc = ko.observable<string>();
    beforePatchEditor: AceAjax.Editor;

    afterPatch = ko.observable<string>();
    afterPatchDoc = ko.observable<string>();
    afterPatchEditor: AceAjax.Editor;

    loadedDocuments = ko.observableArray<string>();
    putDocuments = ko.observableArray<any>();
    outputLog = ko.observableArray<string>();

    documentKey = ko.observable<string>();
    keyOfTestedDocument: KnockoutComputed<string>;

    constructor() {
        super();

        // When we programmatically change the document text or meta text, push it into the editor.
        this.beforePatchDocMode.subscribe(() => {
            if (this.beforePatchEditor) {
                var text = this.beforePatchDocMode() ? this.beforePatchDoc() : this.beforePatchMeta();
                this.beforePatchEditor.getSession().setValue(text);
            }
        });
        this.beforePatch = ko.computed({
            read: () => {
                return this.beforePatchDocMode() ? this.beforePatchDoc() : this.beforePatchMeta();
            },
            write: (text: string) => {
                var currentObservable = this.beforePatchDocMode() ? this.beforePatchDoc : this.beforePatchMeta;
                currentObservable(text);
            },
            owner: this
        });

        this.afterPatchDocMode.subscribe(() => {
            if (this.afterPatchEditor) {
                var text = this.afterPatchDocMode() ? this.afterPatchDoc() : this.afterPatchMeta();
                this.afterPatchEditor.getSession().setValue(text);
            }
        });
        this.afterPatch = ko.computed({
            read: () => {
                return this.afterPatchDocMode() ? this.afterPatchDoc() : this.afterPatchMeta();
            },
            write: (text: string) => {
                var currentObservable = this.afterPatchDocMode() ? this.afterPatchDoc : this.afterPatchMeta;
                currentObservable(text);
            },
            owner: this
        });
    }

    compositionComplete() {
        super.compositionComplete();

        var beforePatchEditorElement = $("#beforePatchEditor");
        if (beforePatchEditorElement.length > 0) {
            this.beforePatchEditor = ko.utils.domData.get(beforePatchEditorElement[0], "aceEditor");
        }

        var afterPatchEditorElement = $("#afterPatchEditor");
        if (afterPatchEditorElement.length > 0) {
            this.afterPatchEditor = ko.utils.domData.get(afterPatchEditorElement[0], "aceEditor");
        }
       
        grid.selection.subscribe(selection => {
            if (selection.count === 1) {
                var document = selection.included[0];
                // load document directly from server as documents on list are loaded using doc-preview endpoint, which doesn't display entire document
                this.loadDocumentToTest(document.__metadata.id);
                this.documentKey(document.__metadata.id);
            } else {
                this.clearDocumentPreview();
            }
        });

        //TODO: install doc preview tooltip
    }

    activate(recentPatchHash?: string) {
        this.isExecuteAllowed = ko.computed(() => !!this.patchDocument().script() && !!this.beforePatchDoc());
        this.keyOfTestedDocument = ko.computed(() => {
            switch (this.patchDocument().patchOnOption()) {
                case "Collection":
                case "Index":
                    return this.documentKey();
                case "Document":
                    return this.patchDocument().selectedItem();
            }
        });

        if (recentPatchHash) {
            this.selectInitialPatch(recentPatchHash);
        }
    }

    detached() {
        super.detached();
        aceEditorBindingHandler.detached();
    }

    loadDocumentToTest(selectedItem: string) {
        if (selectedItem) {
            var loadDocTask = new getDocumentWithMetadataCommand(selectedItem, this.activeDatabase()).execute();
            loadDocTask.done(document => {
                this.beforePatchDoc(JSON.stringify(document.toDto(), null, 4));
                this.beforePatchMeta(JSON.stringify(documentMetadata.filterMetadata(document.__metadata.toDto()), null, 4));
            }).fail(() => this.clearDocumentPreview());
        } else {
            this.clearDocumentPreview();
        }
    }

    private clearDocumentPreview() {
        this.beforePatchDoc("");
        this.beforePatchMeta("");
        this.afterPatchDoc("");
        this.afterPatchMeta("");
        this.putDocuments([]);
        this.loadedDocuments([]);
        this.outputLog([]);
    }

    testPatch() {
        eventsCollector.default.reportEvent("patch", "test");

        var values: dictionary<string> = {};
        this.patchDocument().parameters().map(param => {
            var dto = param.toDto();
            values[dto.Key] = dto.Value;
        });
        var bulkDocs: Array<Raven.Server.Documents.Handlers.CommandData> = [];
        bulkDocs.push({
            Key: this.keyOfTestedDocument(),
            Method: 'PATCH',
            DebugMode: true,
            Patch: {
                Script: this.patchDocument().script(),
                Values: values
            }
        });
        new executePatchCommand(bulkDocs, this.activeDatabase(), true)
            .execute()
            .done((result: Raven.Server.Documents.Handlers.CommandData[]) => {
                var testResult = new document((<any>result).Results[0].AdditionalData['Document']);
                this.afterPatchDoc(JSON.stringify(testResult.toDto(), null, 4));
                this.afterPatchMeta(JSON.stringify(documentMetadata.filterMetadata(testResult.__metadata.toDto()), null, 4));
                this.updateActions((<any>result).Results[0].AdditionalData['Actions']);
                this.outputLog((<any>result).Results[0].AdditionalData["Debug"]);
            })
            .fail((result: JQueryXHR) => console.log(result.responseText));
        this.recordPatchRun();
    }

    private updatePageUrl(hash: number) {
        // Put the patch into the URL, so that if the user refreshes the page, he's still got this patch loaded.
        var queryUrl = appUrl.forPatch(this.activeDatabase(), hash);
        this.updateUrl(queryUrl);
    }

    private updateActions(actions: { PutDocument: any[]; LoadDocument: any }) {
        this.loadedDocuments(actions.LoadDocument || []);
        this.putDocuments((actions.PutDocument || []).map(doc => jsonUtil.syntaxHighlight(doc)));
    }

    isTestIndex = ko.observable<boolean>(false);
    }*/
}

export = patch;