const fs = require('fs');
const path = require('path');
const { logger } = require('./logger');
const { choose, fieldText } = require('./model');

const ENV_PATH = path.join(__dirname, '../../.env');

function getSettings() {
  return {
    typeSafeApiKey: process.env.TYPESAFE_API_KEY || '',
    typeSafeModel: process.env.TYPESAFE_MODEL || 'jev-latest',
    textModelApiKey: process.env.TEXT_MODEL_API_KEY || '',
    textModelBaseUrl: process.env.TEXT_MODEL_BASE_URL || 'https://api.minimaxi.com/v1',
    textModel: process.env.TEXT_MODEL || 'MiniMax-M3',
    textModelReasoning: process.env.TEXT_MODEL_REASONING || 'none',
  };
}

function saveSettings(settings) {
  if (!settings) return { success: false, error: 'Empty settings' };

  // 1. Hot update process.env in-memory
  if (settings.typeSafeApiKey !== undefined) process.env.TYPESAFE_API_KEY = settings.typeSafeApiKey.trim();
  if (settings.typeSafeModel !== undefined) process.env.TYPESAFE_MODEL = settings.typeSafeModel.trim();
  if (settings.textModelApiKey !== undefined) process.env.TEXT_MODEL_API_KEY = settings.textModelApiKey.trim();
  if (settings.textModelBaseUrl !== undefined) process.env.TEXT_MODEL_BASE_URL = settings.textModelBaseUrl.trim().replace(/\/+$/, '');
  if (settings.textModel !== undefined) process.env.TEXT_MODEL = settings.textModel.trim();
  if (settings.textModelReasoning !== undefined) process.env.TEXT_MODEL_REASONING = settings.textModelReasoning.trim();

  // 2. Persist to .env file
  try {
    const envContent = [
      `TYPESAFE_API_KEY=${process.env.TYPESAFE_API_KEY || ''}`,
      `TYPESAFE_MODEL=${process.env.TYPESAFE_MODEL || 'jev-latest'}`,
      `# Helper LLM for TYPE_TEXT text generation`,
      `TEXT_MODEL_API_KEY=${process.env.TEXT_MODEL_API_KEY || ''}`,
      `TEXT_MODEL_BASE_URL=${process.env.TEXT_MODEL_BASE_URL || 'https://api.minimaxi.com/v1'}`,
      `TEXT_MODEL=${process.env.TEXT_MODEL || 'MiniMax-M3'}`,
      `TEXT_MODEL_REASONING=${process.env.TEXT_MODEL_REASONING || 'none'}`,
      '',
    ].join('\n');

    fs.writeFileSync(ENV_PATH, envContent, 'utf8');
    logger.info('SYS', `配置已保存并热更新生效: Jev [${process.env.TYPESAFE_MODEL}], 文本模型 [${process.env.TEXT_MODEL}]`);
    return { success: true };
  } catch (err) {
    logger.error('SYS', `写入 .env 失败: ${err.message}`);
    return { success: false, error: err.message };
  }
}

async function testConnection(type, config) {
  try {
    if (type === 'typesafe') {
      const origKey = process.env.TYPESAFE_API_KEY;
      const origModel = process.env.TYPESAFE_MODEL;
      const testKey = (config?.typeSafeApiKey || origKey || '').trim();
      const testModel = (config?.typeSafeModel || origModel || 'jev-latest').trim();

      if (!testKey) throw new Error('缺少 TypeSafe / Jev API Key');

      process.env.TYPESAFE_API_KEY = testKey;
      process.env.TYPESAFE_MODEL = testModel;

      try {
        const fakeState = {
          url: 'https://test.local',
          title: 'Ping Test',
          text: 'Ping',
          actions: [
            { id: 'e1', node: 1, kind: 'click', label: 'OK Button', role: 'button' },
          ],
        };
        const decision = await choose(fakeState, 'Click OK Button', []);
        return {
          success: true,
          message: `连接成功 (模型: ${testModel}, 响应: ${decision.choice}, 耗时: ${decision.latency_ms}ms)`,
        };
      } finally {
        process.env.TYPESAFE_API_KEY = origKey;
        process.env.TYPESAFE_MODEL = origModel;
      }
    }

    if (type === 'text_model') {
      const origKey = process.env.TEXT_MODEL_API_KEY;
      const origBase = process.env.TEXT_MODEL_BASE_URL;
      const origModel = process.env.TEXT_MODEL;

      const testKey = (config?.textModelApiKey || origKey || '').trim();
      const testBase = (config?.textModelBaseUrl || origBase || 'https://api.minimaxi.com/v1').trim().replace(/\/+$/, '');
      const testModel = (config?.textModel || origModel || 'MiniMax-M3').trim();

      if (!testKey) throw new Error('缺少文本生成模型 API Key');

      process.env.TEXT_MODEL_API_KEY = testKey;
      process.env.TEXT_MODEL_BASE_URL = testBase;
      process.env.TEXT_MODEL = testModel;

      try {
        const textCtx = {
          goal: 'Find one-way flight to Shenzhen',
          field: { label: 'Destination', role: 'combobox', value: '' },
          page: { title: 'Flight search', text: 'Search' },
          recent_actions: [],
        };
        const res = await fieldText(textCtx);
        return {
          success: true,
          message: `连接成功 (生成: "${res.value}", 耗时: ${res.helper?.latency_ms || 0}ms)`,
        };
      } finally {
        process.env.TEXT_MODEL_API_KEY = origKey;
        process.env.TEXT_MODEL_BASE_URL = origBase;
        process.env.TEXT_MODEL = origModel;
      }
    }

    throw new Error('未知的测试类型');
  } catch (err) {
    return { success: false, error: err.message };
  }
}

module.exports = {
  getSettings,
  saveSettings,
  testConnection,
};
