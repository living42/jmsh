const axios = require("axios").default;
const axiosCookieJarSupport = require("@3846masa/axios-cookiejar-support").default;
const CookieJar = require("tough-cookie").CookieJar;

axiosCookieJarSupport(axios);

const cookieJar = new CookieJar();

const client = axios.create({
  jar: cookieJar,
  withCredentials: true,
  validateStatus: (status) => 200 <= status && status <= 400
});

client.cookies = cookieJar;

exports.client = client;
