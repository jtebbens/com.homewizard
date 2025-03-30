'use strict';

const fetch = require('node-fetch');
const https = require('https');

// Helper method to request a token from the device
async function requestToken(address) {
  const payload = {
    name: 'local/homey_user',
  };

  console.log('Trying to get token...');

  // The request...
  const response = await fetch(`https:/${address}/api/user`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Api-Version': '2',
    },
    body: JSON.stringify(payload),
    agent: new (https.Agent)({ rejectUnauthorized: false }),
  });

  // See if we get an unauthorized response, meaning the button has not been pressed yet
  if (response.status == 403) {
    console.log('Button not pressed yet...');
    return null;
  }

  // Some error checking
  if (response.status != 200) {
    throw new Error(response.statusText);
  }

  const result = await response.json();

  if (result.token === undefined) {
    throw new Error('No token received');
  }

  return result.token;
}

module.exports = { requestToken };
