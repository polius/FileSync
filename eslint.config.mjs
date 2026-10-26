import globals from 'globals';

export default [
  {
    ignores: ['**/node_modules/**', '**/.venv/**', 'web/js/vendors/**', 'e2e/**'],
  },
  {
    files: ['web/js/**/*.js', 'web/sw.js'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: {
        ...globals.browser,
        ...globals.serviceworker,
      },
    },
    rules: {
      'no-undef': 'error',
      'no-unused-vars': ['error', { args: 'none', caughtErrors: 'none' }],
      'no-const-assign': 'error',
      'no-dupe-keys': 'error',
      'no-fallthrough': 'error',
      'no-async-promise-executor': 'error',
      'no-var': 'error',
      'prefer-const': 'error',
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-implicit-globals': 'error',
      'no-unsafe-optional-chaining': 'error',
      'no-unreachable': 'error',
      'no-self-compare': 'error',
      'no-template-curly-in-string': 'error',
      'no-unused-private-class-members': 'error',
      'no-constant-binary-expression': 'error',
    },
  },
];
