const pLimit = require("p-limit");
const { getEnvironment } = require("../utils/contentfulClient");

const limit = pLimit(5);

// Helper function for logging with timestamp
function log(level, message, data = null) {
  const timestamp = new Date().toISOString();
  const logMessage = `[${timestamp}] [${level.toUpperCase()}] ${message}`;
  if (data) {
    console.log(logMessage, data);
  } else {
    console.log(logMessage);
  }
}

async function migrateMPDictionaryToConstants(payload) {
  const {
    environmentId,
    sourceContentTypeId,
    sourceEntryId,
    targetContentTypeId,
    keyFieldId,
    valueFieldId,
    internalNameFieldId,
    excludedFieldIds = [],
  } = payload;

  try {
    if (!environmentId) {
      throw new Error("environmentId must be provided in request body");
    }

    log("info", "Starting migration process", { environmentId, sourceContentTypeId, sourceEntryId, targetContentTypeId });

    const environment = await getEnvironment(environmentId);

    // Only fetch default locale (no need to map all locales)
    const localesResponse = await environment.getLocales();
    const defaultLocale = localesResponse.items.find(l => l.default).code;

    const sourceContentType =
      await environment.getContentType(sourceContentTypeId);

    const sourceEntry =
      await environment.getEntry(sourceEntryId);

    // Fetch all existing entries from target content type to check for duplicates
    log("info", `Fetching existing entries from target content type: ${targetContentTypeId}`);
    const existingEntries = await environment.getEntries({
      content_type: targetContentTypeId,
      limit: 1000 // Adjust limit as needed
    });

    // Create a Map of existing keys to entry IDs for quick lookup and logging
    const existingKeys = new Map();
    existingEntries.items.forEach(entry => {
      if (entry.fields[keyFieldId] && entry.fields[keyFieldId][defaultLocale]) {
        existingKeys.set(entry.fields[keyFieldId][defaultLocale], entry.sys.id);
      }
    });
    log("info", `Found ${existingKeys.size} existing entries`, { existingKeys: Array.from(existingKeys.entries()) });

    const createdEntries = [];
    const skippedEntries = [];
    const failedEntries = [];

    const tasks = sourceContentType.fields.map(field =>
      limit(async () => {
        const fieldId = field.id;

        try {
          if (excludedFieldIds.includes(fieldId)) {
            log("info", `Skipping excluded field: ${fieldId}`);
            return;
          }

          const sourceFieldLocales = sourceEntry.fields[fieldId];

          if (!sourceFieldLocales) {
            log("warn", `No source field locales found for field: ${fieldId}`);
            return;
          }

          // Directly copy only existing locales from source
          const valueField = { ...sourceFieldLocales };

          if (Object.keys(valueField).length === 0) {
            log("warn", `Empty value field, skipping field: ${fieldId}`);
            return;
            // Prevents creating empty constants
          }

          // Check if entry with this key already exists using Map
          const existingEntryId = existingKeys.get(fieldId);
          if (existingEntryId) {
            log("info", `Entry already exists for field: ${fieldId} with entry ID: ${existingEntryId}, skipping creation`);
            skippedEntries.push({
              fieldId,
              existingEntryId,
              reason: "Entry already exists"
            });
            return;
          }

          log("info", `Creating entry for field: ${fieldId}`);

          const newEntry = await environment.createEntry(
            targetContentTypeId,
            {
              fields: {
                [keyFieldId]: {
                  [defaultLocale]: fieldId
                },
                [valueFieldId]: valueField,
                [internalNameFieldId]: {
                  [defaultLocale]: `constants | ${fieldId}`
                }
              }
            }
          );

          try {
            await newEntry.publish();
            createdEntries.push(newEntry.sys.id);
            log("info", `Successfully created and published entry for field: ${fieldId}`, { entryId: newEntry.sys.id });
          } catch (publishError) {
            // Log the error but continue processing other entries
            const errorMsg = `Failed to publish entry for field '${fieldId}': ${publishError.message}`;
            log("error", errorMsg, { fieldId, error: publishError.message });
            failedEntries.push({
              fieldId,
              error: errorMsg,
              entryId: newEntry.sys.id
            });
          }

        } catch (fieldError) {
          // Catch any other errors during field processing to not affect other entries
          const errorMsg = `Error processing field '${fieldId}': ${fieldError.message}`;
          log("error", errorMsg, { fieldId, error: fieldError.message });
          failedEntries.push({
            fieldId,
            error: errorMsg
          });
        }
      })
    );

    await Promise.all(tasks);

    log("info", "Migration process completed", { 
      totalProcessed: sourceContentType.fields.length,
      successfulCount: createdEntries.length,
      skippedCount: skippedEntries.length,
      failedCount: failedEntries.length
    });

    // Determine overall success based on whether at least some entries were created
    const success = createdEntries.length > 0;

    return {
      success,
      environmentUsed: environmentId,
      createdCount: createdEntries.length,
      skippedCount: skippedEntries.length,
      failedCount: failedEntries.length,
      createdEntries,
      skippedEntries: skippedEntries.length > 0 ? skippedEntries : undefined,
      failedEntries: failedEntries.length > 0 ? failedEntries : undefined
    };

  } catch (error) {
    log("error", "Fatal error in migration process", { error: error.message, stack: error.stack });
    throw new Error(error.message);
  }
}

module.exports = {
  migrateMPDictionaryToConstants
};
