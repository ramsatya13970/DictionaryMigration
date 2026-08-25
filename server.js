
require("dotenv").config();
const express = require("express");
const { migrateMPDictionaryToConstants } = require("./services/migrationService");
const { migrateKeyValueFromExcel } = require("./services/excelMigrationService");

const app = express();
app.use(express.json());

app.post("/migrate", async (req, res) => {
  try {
    const result = await migrateMPDictionaryToConstants(req.body);
    res.status(200).json(result);
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

app.post("/migrate-from-excel", async (req, res) => {
  try {
    const result = await migrateKeyValueFromExcel(req.body);
    res.status(200).json(result);
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

