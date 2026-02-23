const pLimit = require("p-limit");
const { getEnvironment } = require("../utils/contentfulClient");

const limit = pLimit(5);

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
    publish = false
  } = payload;

  try {
    if (!environmentId) {
      throw new Error("environmentId must be provided in request body");
    }

    const environment = await getEnvironment(environmentId);

    // ✅ Only fetch default locale (no need to map all locales)
    const localesResponse = await environment.getLocales();
    const defaultLocale = localesResponse.items.find(l => l.default).code;

    const sourceContentType =
      await environment.getContentType(sourceContentTypeId);

    const sourceEntry =
      await environment.getEntry(sourceEntryId);

    const createdEntries = [];

    const tasks = sourceContentType.fields.map(field =>
      limit(async () => {
        const fieldId = field.id;

        if (excludedFieldIds.includes(fieldId)) return;

        const sourceFieldLocales = sourceEntry.fields[fieldId];

        if (!sourceFieldLocales) return;

        // ✅ Directly copy only existing locales from source
        const valueField = { ...sourceFieldLocales };

        if (Object.keys(valueField).length === 0) return; 
        // Prevents creating empty constants

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

        if (publish) {
          await newEntry.publish();
        }

        createdEntries.push(newEntry.sys.id);
      })
    );

    await Promise.all(tasks);

    return {
      success: true,
      environmentUsed: environmentId,
      createdCount: createdEntries.length,
      createdEntries
    };

  } catch (error) {
    console.error(error);
    throw new Error(error.message);
  }
}

module.exports = {
  migrateMPDictionaryToConstants
};