import commandBase = require("commands/commandBase");
import document = require("models/database/documents/document");
import database = require("models/resources/database");
import endpoints = require("endpoints");

class saveDocumentCommand extends commandBase {

    constructor(private id: string, private document: document, private db: database, private reportSaveProgress = true) {
        super();
    }

    execute(): JQueryPromise<saveDocumentResponseDto> {
        this.document.__metadata.id = this.id;

        const commands: Array<Raven.Server.Documents.Handlers.CommandData> = [this.document.toBulkDoc("PUT")];

        const args = ko.toJSON(commands);
        const url = endpoints.databases.batch.bulk_docs;
        const saveTask = this.post(url, args, this.db);

        if (this.reportSaveProgress) {
            saveTask.done((result: saveDocumentResponseDto) => this.reportSuccess("Saved " + result.Results[0].Key));
            saveTask.fail((response: JQueryXHR) => this.reportError("Failed to save " + this.id, response.responseText, response.statusText));
        }

        return saveTask;
    }
}

export = saveDocumentCommand;