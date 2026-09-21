#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');

function get(url) {
  return new Promise((resolve, reject) => {
    const client = new URL(url).protocol === 'http:' ? http : https;
    client.get(url, res => {
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => resolve(body));
    }).on('error', reject);
  });
}

async function fetchFirstValidJson(urls, request = get) {
  const failures = [];
  for (const url of urls) {
    try {
      const body = await request(url);
      JSON.parse(body);
      return body;
    } catch (error) {
      failures.push(`${url}: ${error.message}`);
    }
  }
  throw new Error(`no source returned valid JSON\n${failures.join('\n')}`);
}

async function main([output, ...urls]) {
  if (!output || urls.length === 0) {
    throw new Error('usage: node scripts/fetch-json.js OUTPUT URL [URL ...]');
  }
  const body = await fetchFirstValidJson(urls);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, body);
  console.log(`wrote valid JSON to ${output}`);
}

if (require.main === module) {
  main(process.argv.slice(2)).catch(error => {
    console.error(`fetch failed: ${error.message}`);
    process.exit(1);
  });
}

module.exports = { fetchFirstValidJson };
