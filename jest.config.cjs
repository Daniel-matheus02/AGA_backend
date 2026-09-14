/**
 * Jest do backend.
 *
 * O projeto não tem mais nenhuma dependência ESM pura no caminho dos testes
 * (o `otplib` foi removido junto com o MFA), então o `transformIgnorePatterns`
 * volta ao padrão do Jest, que ignora todo o `node_modules`.
 */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/test'],
  moduleFileExtensions: ['ts', 'js', 'json'],
  collectCoverageFrom: ['src/**/*.ts', '!src/generated/**'],
  transform: {
    '^.+\.(t|j)sx?$': ['ts-jest', { tsconfig: { allowJs: true, module: 'commonjs', target: 'ES2023', esModuleInterop: true } }],
  },
  testPathIgnorePatterns: ['<rootDir>/test/security/'],
};
