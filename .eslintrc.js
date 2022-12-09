module.exports = {
  env: {
    browser: true,
    es2021: true,
    node: true
  },
  extends: 'eslint:recommended',
  overrides: [
  ],
  parserOptions: {
    ecmaVersion: 'latest',
    sourceType: 'module'
  },
  rules: {
    "no-mixed-spaces-and-tabs": 0, // disable rule
    "callback-return": "off",
    "handle-callback-err": "error",
    "no-new-require": "error",
    "no-empty-function": "error",
    "global-require": "error",
    "no-return-await": "error",
    "no-catch-shadow": "error",
    "no-await-in-loop": "error",
    "array-callback-return" : "error"
  }
}
