import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import prettier from "eslint-config-prettier";

export default tseslint.config(
    { ignores: ["dist", "node_modules", ".vite", ".claude"] },
    js.configs.recommended,
    ...tseslint.configs.recommended,
    {
        plugins: {
            "react-hooks": reactHooks,
        },
        rules: {
            "react-hooks/rules-of-hooks": "error",
            // exhaustive-deps is too opinionated; intentional omissions are used throughout
            "react-hooks/exhaustive-deps": "off",
            // The "previous value ref" pattern during render is intentionally used
            "react-hooks/refs": "off",
        },
    },
    prettier
);
