const express = require("express");
const axios = require("axios");
const qs = require("qs");
const cors = require("cors");
const { Pool } = require("pg");
const path = require("path");
require("dotenv").config();

const app = express();

app.use(express.json());
app.use(cors());

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false,
  },
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const HUBSPOT_API_URL = "https://api.hubapi.com/crm/v3/objects/contacts/?properties=custom_url,unique_identifier,email,posthog_url";
const HUBSPOT_API_UPDATE_URL = "https://api.hubapi.com/crm/v3/objects/contacts/";

let tempStorage = {};

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

app.get("/auth/callback", (req, res) => {
  console.log("In auth callback");
  const authCode = req.query.code;
  console.log("authCode : " + authCode);
  tempStorage.authCode = authCode;
  res.sendFile(path.join(__dirname, "index.html"));
});

app.post("/submit", async (req, res) => {
  console.log("In submit");
  const posthogAccessToken = req.body.posthogtoken;
  const authCode = tempStorage.authCode;
  console.log("Posthog Access Token : " + posthogAccessToken);

  try {
    const tokenResponse = await axios.post(
      "https://api.hubapi.com/oauth/v1/token",
      qs.stringify({
        grant_type: "authorization_code",
        client_id: process.env.HUBSPOT_CLIENT_ID,
        client_secret: process.env.HUBSPOT_CLIENT_SECRET,
        redirect_uri: process.env.HUBSPOT_REDIRECT_URI,
        code: authCode,
      }),
      {
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
      }
    );

    const accessToken = tokenResponse.data.access_token;
    console.log("accessToken : " + accessToken);
    const refreshToken = tokenResponse.data.refresh_token;
    console.log("refreshToken : " + refreshToken);

    let portalId;
    try {
      const meResponse = await axios.get(
        "https://api.hubapi.com/integrations/v1/me",
        {
          headers: {
            Authorization: `Bearer ${accessToken}`,
          },
        }
      );
      portalId = meResponse.data.portalId;
      console.log("portalId : " + portalId);
    } catch (error) {
      console.error("Error during getting portal id:", error);
      return res.status(500).send(`Error during getting portal id: ${error.message}`);
    }

    const query = `
      INSERT INTO tokens (portal_id, hubspot_access_token, hubspot_refresh_token, posthog_access_token)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (portal_id) DO UPDATE SET
        hubspot_access_token = EXCLUDED.hubspot_access_token,
        hubspot_refresh_token = EXCLUDED.hubspot_refresh_token,
        posthog_access_token = EXCLUDED.posthog_access_token
    `;
    await pool.query(query, [portalId, accessToken, refreshToken, posthogAccessToken]);
    console.log("Query Saved");
    res.sendFile(path.join(__dirname, "success.html"));
    console.log("After Success");
    await integrateHubSpotAndPostHog(portalId, accessToken);
  } catch (error) {
    console.error("Error during authentication:", error);
    res.status(500).send(`Error during authentication: ${error.message}`);
  }
});

async function integrateHubSpotAndPostHog(portal_id, accessToken) {
  try {
    console.log("In integrateHubSpotAndPostHog");
    const contacts = await getHubSpotContacts(HUBSPOT_API_URL, accessToken);
    console.log("Back in integrateHubSpotAndPostHog");
    console.log("contacts length : ", contacts.length);
    for (const customer of contacts) {
      console.log('customer.properties.email : ', customer.properties.email )
      const customUrlCondition = !customer.properties.custom_url?.trim();
      const uniqueIdentifierCondition = !customer.properties.unique_identifier?.trim();
      console.log('customUrlCondition && uniqueIdentifierCondition : ', customUrlCondition && uniqueIdentifierCondition )
      if (customUrlCondition && uniqueIdentifierCondition) {
        const randomString = generateRandomString(6);
        customer.properties.unique_identifier = randomString;
        customer.properties.custom_url = `https://www.wintactix.com/?${randomString}`;
        await updateHubSpotContact(
          customer.id,
          customer.properties.unique_identifier,
          customer.properties.custom_url,
          accessToken
        );
      }
    }
  } catch (error) {
    console.error("Error in integrateHubSpotAndPostHog:", error);
  }
}

async function getHubSpotContacts(url, accessToken) {
  console.log("In getHubSpotContacts");
  let allContacts = [];
  let nextUrl = url;

  while (nextUrl) {
    console.log('Came in while.');
    try {
      console.log('Came in try.');
      const response = await axios.get(nextUrl, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
      });
      console.log('After Call');
      console.log('Data : ', response.data);
      allContacts = allContacts.concat(response.data.results);
      nextUrl = response.data.paging?.next?.link;
    } catch (error) {
      console.error("Error fetching HubSpot contacts:", error);
      throw error;
    }
  }

  return allContacts;
}

async function updateHubSpotContact(contactId, uniqueIdentifier, customUrl, accessToken) {
  console.log("In updateHubSpotContact");
  const updateData = {
    properties: {
      unique_identifier: uniqueIdentifier,
      custom_url: customUrl,
    },
  };
  const url = `${HUBSPOT_API_UPDATE_URL}${contactId}`;

  try {
    await axios.patch(url, updateData, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
    });
    console.log(`Updated contact ${contactId}.`);
  } catch (error) {
    console.error(`Error updating HubSpot contact ${contactId}:`, error);
  }
}

function generateRandomString(length) {
  const characters = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
  let result = "";
  for (let i = 0; i < length; i++) {
    const randomIndex = Math.floor(Math.random() * characters.length);
    result += characters.charAt(randomIndex);
  }
  return result;
}

app.listen(process.env.PORT || 3000, () => {
  console.log(`Server is running`);
});

module.exports = app;
