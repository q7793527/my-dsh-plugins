// 本插件的 vitest 配置：阈值与仓库根门禁一致（lines 85 / branches 75 / functions 80）。
// coverage 统计整个 lib/，不只 index.js —— 生成与轮询逻辑在 generate.js，
// 只统计入口会让它永远不进门禁。include 指向本插件的 TypeScript 测试，
// 否则继承根配置的 `test/*.mjs` 会静默跳过它们。
export default {
  test: {
    include: ['test/*.test.ts'],
    exclude: ['**/e2e-cdp.mjs', '**/node_modules/**'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    coverage: {
      provider: 'v8',
      include: ['lib/**/*.js'],
      // types.ts 是纯类型文件：只导出 interface/type，经 tsc 类型擦除后
      // 产物不含任何可执行语句（0 行 0 分支）。把它计入覆盖率没有任何
      // 运行时语义可验证，只会稀释整体指标，故从统计中排除。
      exclude: ['**/types.ts', '**/types.js'],
      thresholds: { lines: 85, branches: 75, functions: 80 },
    },
  },
}
