
import globals from "globals";
import pluginJs from "@eslint/js";
import tseslint from "typescript-eslint";
import importPlugin from "eslint-plugin-import";

/** @type {import('eslint').Linter.Config[]} */
export default [
  {
    
    files: ["**/*.ts"],
    languageOptions: {
      globals: globals.browser,
      parser: tseslint.parser,
      
    },
    plugins: {
      
      import: importPlugin
    },
    rules: {
      
      
      "import/order": ["error", {
        "groups": [
            "builtin", 
            "external", 
            "internal", 
            ["parent", "sibling", "index"], 
            "type" 
        ],
        "newlines-between": "always", 
        
        "alphabetize": {
            "order": "asc", 
            "caseInsensitive": true 
        }
      }],

      
      
      
      
      
      
      
      
    }
  },

  
  pluginJs.configs.recommended,

  
  
  ...tseslint.configs.recommended,

  
  
  
  
  
  
];