import base from '../special-workflow-native-eslint.config.mjs';
export default [...base,{files:['public/**'],languageOptions:{globals:{localStorage:'readonly'}}}];
