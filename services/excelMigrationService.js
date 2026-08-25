const fs = require("fs");
const path = require("path");
const xlsx = require("xlsx");
const pLimit = require("p-limit");
const { getEnvironment } = require("../utils/contentfulClient");

const limit = pLimit(5);

function log(level, message, data = null) {
  const timestamp = new Date().toISOString();
  const logMessage = `[${timestamp}] [${level.toUpperCase()}] ${message}`;
  if (data) {
    console.log(logMessage, data);
  } else {
    console.log(logMessage);
  }
}

function normalizeHeader(value) {
  if (!value && value !== 0) return "";
  return value
    .toString()
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

function getLocaleHeaderMap(headers, locales, excelKeyHeader) {
  const localeMap = new Map();
  const normalizedHeaders = headers.map(header => normalizeHeader(header));

  locales.items.forEach(locale => {
    const codeNormalized = normalizeHeader(locale.code);
    const nameNormalized = normalizeHeader(locale.name);
    localeMap.set(codeNormalized, locale.code);
    localeMap.set(nameNormalized, locale.code);
    localeMap.set(`${nameNormalized}${codeNormalized}`, locale.code);
    localeMap.set(`${codeNormalized}${nameNormalized}`, locale.code);
  });

  const headerToLocale = {};

  headers.forEach((header, index) => {
    const normalized = normalizedHeaders[index];
    if (normalized === normalizeHeader(excelKeyHeader)) {
      return;
    }

    const matched = localeMap.get(normalized);
    if (matched) {
      headerToLocale[header] = matched;
      return;
    }

    const codeMatch = locales.items.find(locale =>
      normalizeHeader(locale.code) === normalized ||
      normalizeHeader(locale.name) === normalized ||
      normalizeHeader(`${locale.name} ${locale.code}`) === normalized ||
      normalizeHeader(`${locale.code} ${locale.name}`) === normalized
    );

    if (codeMatch) {
      headerToLocale[header] = codeMatch.code;
    }
  });

  return headerToLocale;
}

async function fetchAllExistingEntries(environment, targetContentTypeId, keyFieldId, defaultLocale) {
  const existingEntries = new Map();
  let skip = 0;
  const pageLimit = 1000;
  let hasMore = true;

  while (hasMore) {
    const response = await environment.getEntries({
      content_type: targetContentTypeId,
      // Request sys.publishedAt so we can reliably detect published entries
      select: [`sys.id`, `sys.publishedAt`, `fields.${keyFieldId}`, `fields`].join(","),
      limit: pageLimit,
      skip
    });
    
    console.log("responseLength..........................",response.items.length);
    // console.log("response..........................",response);
    
    response.items.forEach(entry => {
      // Only include entries that have been published
      if (!entry.sys || !entry.sys.publishedAt) {
        return;
      }

      const keyValue = entry.fields?.[keyFieldId]?.[defaultLocale];
      if (keyValue) {
        if(existingEntries.has(keyValue)) {
          console.warn(`Duplicate key value detected in existing entries: ${keyValue} Overwriting previous entry.`);
        }
        existingEntries.set(keyValue, entry);
      }
    });

    if (response.items.length < pageLimit) {
      hasMore = false;
    } else {
      skip += pageLimit;
    }
  }

  console.log(`Fetched ${existingEntries.size} existing entries from Contentful for content type ${targetContentTypeId}`);
  return existingEntries;
}

function parseExcelFile(excelFilePath, excelKeyHeader) {
  if (!fs.existsSync(excelFilePath)) {
    throw new Error(`Excel file not found at path: ${excelFilePath}`);
  }

  const workbook = xlsx.readFile(excelFilePath, { cellDates: true, raw: false });
  const sheetName = workbook.SheetNames[0];
  const worksheet = workbook.Sheets[sheetName];

  if (!worksheet) {
    throw new Error(`No worksheet found in Excel file: ${excelFilePath}`);
  }

  const rows = xlsx.utils.sheet_to_json(worksheet, { defval: null, raw: false });
  if (rows.length === 0) {
    throw new Error(`Excel file contains no data: ${excelFilePath}`);
  }

  const headers = xlsx.utils.sheet_to_json(worksheet, { header: 1, defval: null })[0] || [];
  const normalizedKeyHeader = normalizeHeader(excelKeyHeader);
  const hasKeyHeader = headers.some(header => normalizeHeader(header) === normalizedKeyHeader);

  if (!hasKeyHeader) {
    throw new Error(`Excel file must include a header column matching '${excelKeyHeader}'. Found: ${headers.join(", ")}`);
  }

  return { rows, headers };
}

async function migrateKeyValueFromExcel(payload) {
  const {
    environmentId,
    targetContentTypeId,
    keyFieldId,
    valueFieldId,
    internalNameFieldId,
    excelFileName,
    excelFolderPath = ".",
    sheetName,
    keyFieldName = "key_name",
  } = payload;

  if (!environmentId) throw new Error("environmentId must be provided in request body");
  if (!targetContentTypeId) throw new Error("targetContentTypeId must be provided in request body");
  if (!keyFieldId) throw new Error("keyFieldId must be provided in request body");
  if (!valueFieldId) throw new Error("valueFieldId must be provided in request body");
  if (!excelFileName) throw new Error("excelFileName must be provided in request body");

  // Resolve excel file path. Be permissive: if the exact path isn't found,
  // attempt to auto-discover the file in common folders (./excel, ./services/excelFileForKeyMigration, etc.).
  const defaultFolder = path.isAbsolute(excelFolderPath)
    ? excelFolderPath
    : path.join(process.cwd(), excelFolderPath || "");

  const searchFolders = [
    defaultFolder,
    path.join(process.cwd(), "excel"),
    path.join(process.cwd(), "services", "excelFileForKeyMigration"),
    path.join(process.cwd(), "services")
  ].filter(Boolean);

  let excelFilePath = null;

  // If user provided a filename, try resolving it in the provided/default folders first
  if (excelFileName) {
    for (const folder of searchFolders) {
      try {
        const candidate = path.join(folder, excelFileName);
        if (fs.existsSync(candidate)) {
          excelFilePath = candidate;
          break;
        }
      } catch (e) {
        // ignore and continue
      }
    }
  }

  // If not found yet, attempt to discover a single Excel file in the common folders
  if (!excelFilePath) {
    for (const folder of searchFolders) {
      try {
        if (!fs.existsSync(folder)) continue;
        const files = fs.readdirSync(folder).filter(f => /\.(xlsx|xls)$/i.test(f));
        if (files.length === 1) {
          excelFilePath = path.join(folder, files[0]);
          break;
        }
        if (files.length > 1) {
          const pref = files.find(f => /translation|keys|dictionary/i.test(f));
          if (pref) {
            excelFilePath = path.join(folder, pref);
            break;
          }
        }
      } catch (e) {
        // ignore and continue
      }
    }
  }

  if (!excelFilePath) {
    throw new Error("Excel file not found. Provide `excelFileName` and ensure file exists in the project or place it in an `excel/` folder.");
  }

  log("info", "Starting Excel migration", { environmentId, targetContentTypeId, excelFilePath });

  const environment = await getEnvironment(environmentId);
  const localesResponse = await environment.getLocales();
  const defaultLocale = localesResponse.items.find(locale => locale.default)?.code;
  if (!defaultLocale) {
    throw new Error("Default locale could not be determined for the Contentful environment");
  }


  const { rows, headers } = parseExcelFile(excelFilePath, keyFieldName);
  console.log('rows...............', rows);
  console.log('headers...............', headers);
  const localeHeaderMap = getLocaleHeaderMap(headers, localesResponse, keyFieldName);
  console.log('localeHeaderMap...............', localeHeaderMap);
  const existingEntries = await fetchAllExistingEntries(environment, targetContentTypeId, keyFieldId, defaultLocale);
  log("info", `Loaded ${existingEntries.size} existing entries from target content type`, { targetContentTypeId });

  console.log(`Excel file path resolved: ${excelFilePath}`);
  console.log(`Processing ${rows.length} header..........: ${headers.join(", ")}`);
  console.log(`Default locale detected: ${defaultLocale}`);
  console.log(`Locale header mapping: ${JSON.stringify(localeHeaderMap, null, 2)}`);
  console.log(`Existing entries loaded: ${existingEntries.size}`);

  

  const createdEntries = [];
  const updatedEntries = [];
  const publishedEntries = [];
  const skippedEntries = [];
  const failedEntries = [];
  const operationalLogs = [];

  const tasks = rows.map(row =>
    limit(async () => {
      try {
        const rowKeyName = Object.keys(row).find(
          header => normalizeHeader(header) === normalizeHeader(keyFieldName)
        );
        const keyName = row[rowKeyName];

        if (!keyName || String(keyName).trim() === "") {
          skippedEntries.push({ reason: "Missing key_name", row });
          return;
        }

        const normalizedKeyName = String(keyName).trim();
        const localeValues = {};

        Object.entries(row).forEach(([header, rawValue]) => {
          if (!header || normalizeHeader(header) === normalizeHeader(keyFieldName)) return;
          const localeCode = localeHeaderMap[header];
          if (!localeCode) return;

          if (rawValue !== null && rawValue !== undefined && String(rawValue).trim() !== "") {
            localeValues[localeCode] = String(rawValue);
          }
        });

        if (Object.keys(localeValues).length === 0) {
          skippedEntries.push({ keyName: normalizedKeyName, reason: "No locale values provided" });
          return;
        }

        const existingEntry = existingEntries.get(normalizedKeyName);

        if (existingEntry) {
          const currentValues = existingEntry.fields?.[valueFieldId] || {};
          const updateFields = {};

          Object.entries(localeValues).forEach(([localeCode, excelValue]) => {
            const currentValue = currentValues[localeCode];
            if (currentValue === undefined || currentValue === null || currentValue === "" || currentValue !== excelValue) {
              updateFields[localeCode] = excelValue;
            }
          });

          if (Object.keys(updateFields).length === 0) {
            skippedEntries.push({
              keyName: normalizedKeyName,
              entryId: existingEntry.sys.id,
              reason: "Values already match"
            });
            return;
          }

          existingEntry.fields = existingEntry.fields || {};
          existingEntry.fields[valueFieldId] = {
            ...currentValues,
            ...updateFields
          };

          await existingEntry.update();
          updatedEntries.push({ entryId: existingEntry.sys.id, keyName: normalizedKeyName, updatedLocales: Object.keys(updateFields) });
          operationalLogs.push({ status: "updated", entryId: existingEntry.sys.id, keyName: normalizedKeyName });

          try {
            await existingEntry.publish();
            publishedEntries.push({ entryId: existingEntry.sys.id, keyName: normalizedKeyName });
            operationalLogs.push({ status: "published", entryId: existingEntry.sys.id, keyName: normalizedKeyName });
          } catch (publishError) {
            failedEntries.push({ entryId: existingEntry.sys.id, keyName: normalizedKeyName, error: publishError.message });
            operationalLogs.push({ status: "publish_failed", entryId: existingEntry.sys.id, keyName: normalizedKeyName, error: publishError.message });
          }

          return;
        }

        const createFields = {
          [keyFieldId]: {
            [defaultLocale]: normalizedKeyName
          },
          [valueFieldId]: localeValues
        };

        if (internalNameFieldId) {
          createFields[internalNameFieldId] = {
            [defaultLocale]: `constants | ${normalizedKeyName}`
          };
        }

        const newEntry = await environment.createEntry(targetContentTypeId, { fields: createFields });
        createdEntries.push({ entryId: newEntry.sys.id, keyName: normalizedKeyName });
        operationalLogs.push({ status: "created", entryId: newEntry.sys.id, keyName: normalizedKeyName });

        try {
          await newEntry.publish();
          publishedEntries.push({ entryId: newEntry.sys.id, keyName: normalizedKeyName });
          operationalLogs.push({ status: "published", entryId: newEntry.sys.id, keyName: normalizedKeyName });
        } catch (publishError) {
          failedEntries.push({ entryId: newEntry.sys.id, keyName: normalizedKeyName, error: publishError.message });
          operationalLogs.push({ status: "publish_failed", entryId: newEntry.sys.id, keyName: normalizedKeyName, error: publishError.message });
        }
      } catch (error) {
        const keyName = row[keyFieldName] || row[Object.keys(row).find(header => normalizeHeader(header) === normalizeHeader(keyFieldName))] || "unknown";
        failedEntries.push({ keyName, error: error.message });
        operationalLogs.push({ status: "failed", keyName, error: error.message });
        log("error", `Failed migrating Excel row for key ${keyName}`, { error: error.message });
      }
    })
  );

  await Promise.all(tasks);

  log("info", "Excel migration completed", {
    created: createdEntries.length,
    updated: updatedEntries.length,
    published: publishedEntries.length,
    skipped: skippedEntries.length,
    failed: failedEntries.length
  });

  return {
    success: failedEntries.length === 0,
    environmentId,
    targetContentTypeId,
    excelFilePath,
    defaultLocale,
    createdCount: createdEntries.length,
    updatedCount: updatedEntries.length,
    publishedCount: publishedEntries.length,
    skippedCount: skippedEntries.length,
    failedCount: failedEntries.length,
    createdEntries,
    updatedEntries,
    publishedEntries,
    skippedEntries,
    failedEntries,
    operationalLogs
  };
}

module.exports = {
  migrateKeyValueFromExcel
};
