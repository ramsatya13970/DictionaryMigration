
const contentful = require("contentful-management");

const client = contentful.createClient({
  accessToken: process.env.CONTENTFUL_MANAGEMENT_TOKEN
});

async function getEnvironment(environmentId) {
  if (!environmentId) {
    throw new Error("environmentId is required in request body");
  }

  const space = await client.getSpace(process.env.CONTENTFUL_SPACE_ID);
  return space.getEnvironment(environmentId);
}

module.exports = { getEnvironment };
