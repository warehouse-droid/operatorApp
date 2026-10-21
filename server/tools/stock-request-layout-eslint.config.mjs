import base from './special-workflow-queue-eslint.config.mjs';
export default [...base,{languageOptions:{globals:{prompt:'readonly'}}}];
