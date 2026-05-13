import { Memory } from '@mastra/memory';
import { LibSQLStore } from '@mastra/libsql';

/**
 * ICT PD Array 决策大脑专用对话记忆（与 wyckoff 分析师的库文件分离）。
 * 文件：项目根目录 ict_pd_array_agent_memory.db（*.db 已被 gitignore）。
 */
export const ictPdArrayAgentMemory = new Memory({
  name: 'ict-pd-array-analyst-memory',
  storage: new LibSQLStore({
    id: 'ict-pd-array-memory-sqlite',
    url: 'file:./ict_pd_array_agent_memory.db',
  }),
  options: {
    lastMessages: 40,
  },
});
