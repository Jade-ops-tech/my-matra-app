import { Memory } from '@mastra/memory';
import { LibSQLStore } from '@mastra/libsql';

/**
 * 威科夫/ICT 分析师专用对话记忆（LibSQL 本地文件，与主 mastra.db 分离）。
 * 在项目根目录生成 wyckoff_agent_memory.db（已被 .gitignore 的 *.db 忽略）。
 *
 * 程序化调用时请传入稳定 threadId，例如：
 *   agent.generate(messages, { threadId: 'chat-session-001', resourceId: 'user-1' })
 *
 * @see https://mastra.ai/docs/memory/overview
 */
export const wyckoffAgentMemory = new Memory({
  name: 'wyckoff-ict-master-memory',
  storage: new LibSQLStore({
    id: 'wyckoff-memory-sqlite',
    url: 'file:./wyckoff_agent_memory.db',
  }),
  options: {
    lastMessages: 40,
  },
});
