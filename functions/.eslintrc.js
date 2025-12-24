module.exports = {
  root: true,
  env: {
    es2021: true,
    node: true,
  },
  extends: [
    'eslint:recommended',
  ],
  parserOptions: {
    ecmaVersion: 2021,
  },
  rules: {
    // Keeping this intentionally minimal so deploys are not blocked by style-only rules.
  },
};
