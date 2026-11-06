export { computeLocalMatch } from './local-matcher'
export { matchResumeToJob, batchMatchJobs } from './remote-matcher'
export { analyzeResumeQuality } from './resume-analyzer'
export { analyzeJobMatch } from './job-match-analyzer'
export type { JobMatchAnalysis } from './job-match-analyzer'
export {
  chatCompletion,
  chatCompletionStream,
  chatCompletionWithVision,
  isVisionCapableModel,
  testAIConnection,
  checkAIConfigured,
} from './api-client'
export type { ChatImageInput } from './api-client'
export { getAiBudgetLimit, getAiUsageToday, resetAiBudget, isAiBudgetExhausted } from './ai-budget'
export { BUILTIN_MODELS, getPresetById, getDefaultPreset, getCustomModels, saveCustomModels, getAllModels, generateCustomModelId } from './model-presets'
export type { ModelPreset } from './model-presets'
export { generateJobGreeting } from './greeting'
export type { GreetingGenerationResult } from './greeting'
export { prefetchNextTasksAI } from './prefetch'
export {
  assessJobRelevance,
  computeLocalRelevance,
  parseRelevanceResponse,
  buildRelevanceSignature,
  MAX_AI_REVIEW_JOBS,
} from './job-relevance'
export type { JobRelevanceInput, JobRelevanceResult, RelevanceJob, RelevanceSource } from './job-relevance'
