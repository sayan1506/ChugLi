module.exports = {
  root: true,
  extends: ['@react-native/eslint-config'],
  parserOptions: {
    project: './tsconfig.json',
    tsconfigRootDir: __dirname,
    requireConfigFile: false,
  },
  ignorePatterns: ['node_modules/', 'dist/', '.expo/', '*.config.*', '.eslintrc.js'],
  rules: {
    '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
    'eol-last': 'warn',
  },
};