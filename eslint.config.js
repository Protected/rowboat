import js from "@eslint/js";
import globals from "globals";
import { defineConfig } from "eslint/config";

export default defineConfig([
    {
        files: ["**/*.{js,mjs,cjs}"],
        plugins: { js },
        extends: ["js/recommended"],
        languageOptions: { globals: globals.node },
        rules: {
            "curly": ["warn"],
            "default-case-last": ["warn"],
            "eqeqeq": ["warn"],
            "no-await-in-loop": ["warn"],
            "no-constant-condition": ["error"],
            "no-duplicate-imports": ["error"],
            "no-empty": ["warn"],
            "no-self-compare": ["error"],
            "no-unreachable-loop": ["error"],
            "no-unused-vars": ["warn", {caughtErrors: "none"}],
            "no-use-before-define": ["error", {allowNamedExports: true}],
            "no-useless-assignment": ["off"],
            "no-useless-escape": ["warn"],
            "no-var": ["error"],
            "prefer-const": ["error"],
            "require-atomic-updates": ["error"],
            "valid-typeof": ["error"],
        }
    },
]);
