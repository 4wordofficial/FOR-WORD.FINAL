module.exports = {
  root: true,
  env: {
    es2021: true,
    node: true,
  },
  extends: ["eslint:recommended", "google"],
  parserOptions: {
    ecmaVersion: "latest",
    sourceType: "script",
  },
  rules: {
    "require-jsdoc": "off",
    "no-undef": "off",
    "camelcase": "off",
    "max-len": "off",
  },
};
