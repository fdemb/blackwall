// openapi-typescript drives the TypeScript compiler API, which TypeScript 7 no longer ships,
// so it gets its own TypeScript 5 instead of the app's.
module.exports = {
  hooks: {
    readPackage(pkg) {
      if (pkg.name === "openapi-typescript") {
        delete pkg.peerDependencies.typescript;
        pkg.dependencies.typescript = "^5.9.0";
      }
      return pkg;
    },
  },
};
