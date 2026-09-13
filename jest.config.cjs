/**
 * Jest do backend.
 *
 * `otplib` (e o `@scure/base` que ele usa) é publicado como ESM, então o Jest
 * não consegue interpretá-lo sem passar pelo transform. Por isso os dois entram
 * no `transformIgnorePatterns` como exceção: sem isso, importar qualquer coisa
 * que chegue ao `AuthService` — ou ao `PanelAuthService` — falha com
 * "SyntaxError: Unexpected token 'export'".
 */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/test'],
  moduleFileExtensions: ['ts', 'js', 'json'],
  collectCoverageFrom: ['src/**/*.ts', '!src/generated/**'],
  // `otplib`, `@scure/base` e `@noble/hashes` são ESM puro ("type": "module"): o ts-jest precisa
  // transformá-los, então eles saem do ignore padrão do node_modules.
  transformIgnorePatterns: ['node_modules/(?!(?:@otplib|otplib|@scure|@noble)/)'],
  transform: {
    '^.+\.(t|j)sx?$': ['ts-jest', { tsconfig: { allowJs: true, module: 'commonjs', target: 'ES2023', esModuleInterop: true } }],
  },
  testPathIgnorePatterns: ['<rootDir>/test/security/'],
};
