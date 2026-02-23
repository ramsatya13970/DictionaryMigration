
require("dotenv").config();
const express = require("express");
const { migrateMPDictionaryToConstants } = require("./services/migrationService");

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

app.listen(process.env.PORT, () => {
  console.log(`Server running on port ${process.env.PORT}`);
});
