import React, { useState, useRef, useEffect } from 'react'
import { Card } from '../../components/ui/card'
import { Button } from '../../components/ui/button'
import { Badge } from '../../components/ui/badge'
import { Progress } from '../../components/ui/progress'
import { Dialog } from '../../components/ui/dialog'
import { Toast } from '../../components/ui/toast'
import { getAllResumes, saveResume, deleteResume, setDefaultResume, getResumeById, updateResume } from '../../shared/db/resume-store'
import { setSharedResumeSummary, clearSharedResumeSummary } from '../../shared/db/shared-state'
import { parsePDF, parseWord, extractStructuredData } from '../../shared/parser'
import { analyzeResumeQuality, analyzeJobMatch, checkAIConfigured } from '../../shared/ai'
import type { JobMatchAnalysis } from '../../shared/ai'
import { log, logWarn, logError, logGroup, logGroupEnd } from '../../shared/utils/logger'
import type { Resume, ResumeProfile, Education, WorkExperience } from '../../shared/types/resume'
import { formatDate } from '../../shared/utils/date'
import { saveMatchAnalysis, getAllMatchAnalyses, deleteMatchAnalysis } from '../../shared/db/match-analysis-store'
import type { MatchAnalysisRecord } from '../../shared/db'
import { CandidatePreferencesCard } from '../components/CandidatePreferencesCard'
import {
  Upload, FileText, Star, Trash2, Eye, CheckCircle, AlertCircle,
  Code, Search, XCircle, Bot, ChevronDown, Clock, TrendingUp,
  Pencil, Save, Plus, X,
} from 'lucide-react'

export default function Resumes() {
  const [resumes, setResumes] = useState<Resume[]>([])
  const [loading, setLoading] = useState(false)
  const [selectedResume, setSelectedResume] = useState<Resume | null>(null)
  const [toast, setToast] = useState<{ visible: boolean; message: string; type: 'success' | 'error' | 'warning' | 'info' }>({ visible: false, message: '', type: 'info' })
  const fileInputRef = useRef<HTMLInputElement>(null)

  // ------ 简历编辑 state ------
  const [editing, setEditing] = useState(false)
  const [editForm, setEditForm] = useState<Resume['structuredData'] | null>(null)
  const [newSkill, setNewSkill] = useState('')

  // ------ 岗位匹配分析 state ------
  const [jdText, setJdText] = useState('')
  const [matchResumeId, setMatchResumeId] = useState('')
  const [streaming, setStreaming] = useState(false)
  const [streamText, setStreamText] = useState('')
  const [matchResult, setMatchResult] = useState<JobMatchAnalysis | null>(null)
  const [matchError, setMatchError] = useState('')
  const abortRef = useRef<AbortController | null>(null)
  const streamEndRef = useRef<HTMLDivElement>(null)

  // 历史分析记录
  const [history, setHistory] = useState<MatchAnalysisRecord[]>([])

  useEffect(() => {
    loadResumes()
    loadHistory()
  }, [])

  async function loadHistory() {
    const records = await getAllMatchAnalyses()
    setHistory(records)
  }

  const MOD = 'Popup:Resumes'

  async function loadResumes() {
    const list = await getAllResumes()
    log(MOD, 'loadResumes', `Loaded ${list.length} resumes, default: ${list.find(r => r.isDefault)?.name || 'none'}`)
    setResumes(list)
  }

  async function handleFileUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return

    // Reset input so the same file can be re-uploaded
    if (fileInputRef.current) fileInputRef.current.value = ''

    setLoading(true)
    logGroup(MOD, 'handleFileUpload')
    log(MOD, 'upload', `File: ${file.name} (${(file.size / 1024).toFixed(1)}KB)`)

    try {
      // Validate file size (max 16MB)
      const maxSize = 16 * 1024 * 1024
      if (file.size > maxSize) {
        log(MOD, 'upload', `File too large: ${(file.size / 1024 / 1024).toFixed(1)}MB`)
        showToast(`文件过大：${(file.size / 1024 / 1024).toFixed(1)}MB，请上传小于 16MB 的文件`, 'error')
        logGroupEnd()
        return
      }

      // Validate file type
      const fileType = file.name.endsWith('.pdf') ? 'pdf'
        : file.name.endsWith('.docx') ? 'docx'
        : file.name.endsWith('.doc') ? 'doc'
        : null

      if (!fileType) {
        log(MOD, 'upload', `Unsupported file type: ${file.name}`)
        showToast('不支持的文件格式，请上传 PDF 或 Word 文档', 'error')
        logGroupEnd()
        return
      }

      log(MOD, 'upload', `File type: ${fileType}`)
      showToast(`正在解析${fileType === 'pdf' ? 'PDF' : 'Word'}简历...`, 'info')

      let rawText = ''
      if (fileType === 'pdf') {
        rawText = await parsePDF(file)
      } else {
        rawText = await parseWord(file)
      }
      log(MOD, 'upload', `Parsed rawText: ${rawText.length} chars`)

      // 扫描件 / 图片型 PDF 没有文本层，parsePDF 拿不到内容。
      // 用支持视觉的模型（DeepSeek V4.1 Flash 原生支持图片）把前两页读成文字。
      if (fileType === 'pdf' && rawText.trim().length < 100) {
        try {
          showToast('检测到扫描件简历，正在用视觉模型识别...', 'info')
          const { renderPDFPagesToImages } = await import('../../shared/parser/pdf-parser')
          const { chatCompletionWithVision } = await import('../../shared/ai')
          const images = await renderPDFPagesToImages(file, 2)
          if (images.length > 0) {
            const ocrText = await chatCompletionWithVision(
              '你是专业的简历文字提取助手。逐字提取图片中的简历内容，保留原有分区（个人信息、工作经历、项目经历、教育背景、技能），不要总结、不要编造、不要补充图片里没有的内容。',
              '请把这份简历图片转换成纯文本，尽量保留原文措辞与时间、公司、职位等关键信息。',
              images.map((data) => ({ data })),
              0.1,
            )
            if (ocrText && ocrText.trim().length > rawText.trim().length) {
              rawText = ocrText.trim()
              log(MOD, 'upload', `Vision OCR extracted ${rawText.length} chars from scanned PDF`)
              showToast('扫描件识别完成', 'success')
            }
          }
        } catch (error) {
          logWarn(MOD, 'upload', 'Scanned PDF vision fallback failed', error)
        }
      }

      if (!rawText || !rawText.trim()) {
        log(MOD, 'upload', 'Parsed content is empty')
        showToast('简历内容为空，请检查文件是否损坏或为扫描件图片', 'error')
        logGroupEnd()
        return
      }

      showToast('正在提取结构化信息...', 'info')

      const structuredData = extractStructuredData(rawText)
      log(MOD, 'upload', `Structured data: name=${structuredData.name || 'unknown'}, skills=${structuredData.skills.length}, education=${structuredData.education.length}, work=${structuredData.workExperience.length}`)

      // A1: 生成 AI 简历画像（本地年限/技能分级/成果 + AI 补全），失败不阻断上传
      let profile: ResumeProfile | undefined
      try {
        const { enrichResumeProfile } = await import('../../shared/ai/resume-enricher')
        profile = await enrichResumeProfile(
          { name: '', fileName: file.name, fileType, rawText, structuredData, aiAnalysis: null, isDefault: false } as Resume,
          rawText,
        )
        log(MOD, 'upload', `Resume profile: years=${profile.yearsOfExperience}, skills=${profile.skillLevels.length}, source=${profile.source}`)
      } catch (error) {
        logWarn(MOD, 'upload', 'Resume profile enrichment skipped', error)
      }

      const fileData = await file.arrayBuffer()

      const resume = await saveResume({
        name: file.name.replace(/\.(pdf|docx?)$/i, ''),
        fileName: file.name,
        fileType,
        fileData,
        rawText,
        structuredData,
        profile,
        aiAnalysis: null,
        isDefault: resumes.length === 0,
      })
      log(MOD, 'upload', `Saved to IndexedDB: ${resume.name} (id=${resume.id}, isDefault=${resume.isDefault})`)

      // Sync to chrome.storage.local so content script can read it
      await setSharedResumeSummary(resume)
      log(MOD, 'upload', `Synced to chrome.storage.local: ${resume.name}`)

      showToast('简历上传成功', 'success')
      await loadResumes()
      setSelectedResume(resume)

      // Auto-analyze silently
      try {
        showToast('正在 AI 分析简历...', 'info')
        const analysis = await analyzeResumeQuality(resume)
        if (analysis) {
          const { updateResume } = await import('../../shared/db/resume-store')
          await updateResume(resume.id, { aiAnalysis: analysis })
          await loadResumes()
          showToast('简历解析并 AI 分析完成', 'success')
          log(MOD, 'upload', `AI analysis complete: score=${analysis.overallScore}`)
        }
      } catch {
        log(MOD, 'upload', 'AI analysis skipped (optional)')
      }
      logGroupEnd()
    } catch (err) {
      logError(MOD, 'upload', err)
      logGroupEnd()

      let errorMsg = '上传失败，请重试'
      if (err instanceof Error) {
        // Provide more specific message for common issues
        if (err.message.includes('PDF')) {
          errorMsg = 'PDF 解析失败，请确认文件未加密且可正常打开'
        } else if (err.message.includes('worker')) {
          errorMsg = 'PDF 解析引擎加载失败，请重新加载扩展后重试'
        } else if (err.name === 'QuotaExceededError' || err.message.includes('quota')) {
          errorMsg = '存储空间不足，请清理旧简历后重试'
        } else {
          errorMsg = `上传失败：${err.message}`
        }
      }
      showToast(errorMsg, 'error')
    } finally {
      setLoading(false)
    }
  }

  async function handleAnalyze(resume: Resume) {
    setLoading(true)
    const analysis = await analyzeResumeQuality(resume)
    if (analysis) {
      const { updateResume } = await import('../../shared/db/resume-store')
      await updateResume(resume.id, { aiAnalysis: analysis })
      showToast('简历分析完成', 'success')
      await loadResumes()
    } else {
      showToast('分析失败，请配置AI或检查网络', 'warning')
    }
    setLoading(false)
  }

  async function handleDelete(id: string) {
    logGroup(MOD, 'handleDelete')
    const resume = await getResumeById(id)
    log(MOD, 'delete', `Deleting: ${resume?.name || id} (isDefault=${resume?.isDefault})`)
    await deleteResume(id)
    // If deleted the default resume, clear shared state
    if (resume?.isDefault) {
      await clearSharedResumeSummary()
      log(MOD, 'delete', 'Deleted default resume, cleared shared state')
      // If there are other resumes, make the first one default
      const remaining = await getAllResumes()
      if (remaining.length > 0) {
        log(MOD, 'delete', `Auto-setting new default: ${remaining[0].name}`)
        await handleSetDefault(remaining[0].id)
      }
    }
    await loadResumes()
    if (selectedResume?.id === id) setSelectedResume(null)
    showToast('简历已删除', 'info')
    logGroupEnd()
  }

  async function handleSetDefault(id: string) {
    logGroup(MOD, 'handleSetDefault')
    await setDefaultResume(id)
    await loadResumes()
    // Sync the new default resume to chrome.storage.local
    const updatedList = await getAllResumes()
    const defaultResume = updatedList.find(r => r.id === id)
    if (defaultResume) {
      await setSharedResumeSummary(defaultResume)
      log(MOD, 'setDefault', `Default changed & synced: ${defaultResume.name}`)
    }
    showToast('已设为默认简历', 'success')
    logGroupEnd()
  }

  function showToast(message: string, type: 'success' | 'error' | 'warning' | 'info') {
    setToast({ visible: true, message, type })
    setTimeout(() => setToast({ visible: false, message: '', type: 'info' }), 3000)
  }

  // ====== 简历编辑 ======
  function startEdit(resume: Resume) {
    setEditForm(JSON.parse(JSON.stringify(resume.structuredData)))
    setNewSkill('')
    setEditing(true)
  }

  function cancelEdit() {
    setEditing(false)
    setEditForm(null)
    setNewSkill('')
  }

  function updateEditField<K extends keyof Resume['structuredData']>(key: K, value: Resume['structuredData'][K]) {
    setEditForm(prev => prev ? { ...prev, [key]: value } : prev)
  }

  function updateEducation(index: number, key: keyof Education, value: string) {
    if (!editForm) return
    const education = editForm.education.map((edu, i) => i === index ? { ...edu, [key]: value } : edu)
    setEditForm({ ...editForm, education })
  }

  function updateWork(index: number, key: keyof WorkExperience, value: string) {
    if (!editForm) return
    const workExperience = editForm.workExperience.map((work, i) => i === index ? { ...work, [key]: value } : work)
    setEditForm({ ...editForm, workExperience })
  }

  function addSkill() {
    const skill = newSkill.trim()
    if (!skill || !editForm) return
    if (editForm.skills.some(s => s.toLowerCase() === skill.toLowerCase())) {
      showToast('该技能已在列表中', 'warning')
      return
    }
    setEditForm({ ...editForm, skills: [...editForm.skills, skill] })
    setNewSkill('')
  }

  function removeSkill(skill: string) {
    if (!editForm) return
    setEditForm({ ...editForm, skills: editForm.skills.filter(s => s !== skill) })
  }

  async function saveEdit() {
    if (!selectedResume || !editForm) return
    const updatedStructured = editForm
    try {
      await updateResume(selectedResume.id, {
        structuredData: updatedStructured,
        profile: selectedResume.profile
          ? {
              ...selectedResume.profile,
              yearsOfExperience: updatedStructured.yearsOfExperience || 0,
              generatedAt: new Date().toISOString(),
            }
          : undefined,
      })
      const updated = await getResumeById(selectedResume.id)
      if (updated) {
        // 同步到 chrome.storage.local，内容脚本/评分立即可用新数据
        await setSharedResumeSummary(updated)
        setSelectedResume(updated)
      }
      await loadResumes()
      setEditing(false)
      setEditForm(null)
      setNewSkill('')
      showToast('简历已更新，岗位评分将使用新数据', 'success')
    } catch (err) {
      logError(MOD, 'saveEdit', err)
      showToast('保存失败，请重试', 'error')
    }
  }

  async function handleJobMatch() {
    // 校验
    if (!matchResumeId) { showToast('请先选择一份简历', 'warning'); return }
    if (!jdText.trim()) { showToast('请填写职位描述', 'warning'); return }

    // 检查 AI 配置
    const conn = await checkAIConfigured()
    if (!conn.configured) {
      showToast(`AI 未配置：${conn.reason}`, 'error')
      return
    }

    const resume = resumes.find(r => r.id === matchResumeId)
    if (!resume) { showToast('未找到选中的简历', 'error'); return }

    // 重置状态
    setMatchError('')
    setMatchResult(null)
    setStreamText('')
    setStreaming(true)

    const controller = new AbortController()
    abortRef.current = controller

    // 构建简历文本
    const sd = resume.structuredData
    const resumeText = [
      sd.summary,
      ...sd.workExperience.map(w => `${w.position}@${w.company}: ${w.description}`),
      ...sd.education.map(e => `${e.degree} ${e.major} @${e.school}`),
      ...sd.projects.map(p => `${p.name}(${p.role}): ${p.description}`),
    ].filter(Boolean).join('\n')

    try {
      const result = await analyzeJobMatch(
        resumeText,
        sd.skills,
        jdText.trim(),
        (chunk) => { setStreamText(prev => prev + chunk) },
        controller.signal
      )
      setMatchResult(result)
      // 保存到数据库
      await saveMatchAnalysis({
        resumeId: resume.id,
        resumeName: resume.name,
        jobDescription: jdText.trim(),
        jobTitle: jdText.trim().split('\n')[0].slice(0, 30) || undefined,
        result,
      })
      await loadHistory()
      showToast('分析完成', 'success')
    } catch (err: any) {
      if (err?.name === 'AbortError') {
        setStreamText(prev => prev + '\n\n[已取消]')
      } else {
        const msg = err?.message || '分析失败'
        setMatchError(msg)
        showToast(msg, 'error')
      }
    } finally {
      setStreaming(false)
      abortRef.current = null
    }
  }

  function handleCancelMatch() {
    abortRef.current?.abort()
    setStreaming(false)
  }

  function getScoreColor(score: number) {
    if (score >= 80) return '#10B981'
    if (score >= 60) return '#F59E0B'
    return '#EF4444'
  }

  return (
    <div className="p-4 space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-medium gradient-text">简历管理</h2>
          <a href="#candidate-preferences" className="text-xs text-primary-light hover:underline">
            求职画像 · 底线 · 自主授权 → 本页下方配置
          </a>
        </div>
        <input
          ref={fileInputRef}
          type="file"
          accept=".pdf,.doc,.docx"
          onChange={handleFileUpload}
          className="hidden"
          id="resume-upload"
        />
        <label htmlFor="resume-upload" className="inline-flex items-center justify-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-xl bg-text-primary text-white hover:shadow-card transition-colors duration-200 cursor-pointer">
          <Upload className="w-3.5 h-3.5" />
          上传简历
        </label>
      </div>

      {resumes.length === 0 ? (
        <Card className="py-8 text-center">
          <FileText className="w-10 h-10 mx-auto text-text-muted mb-3" />
          <p className="text-sm text-text-muted mb-4">还没有简历，上传你的第一份简历吧</p>
          <label htmlFor="resume-upload" className="inline-flex items-center justify-center gap-2 px-4 py-2 text-sm font-medium rounded-xl bg-text-primary text-white hover:shadow-card transition-colors duration-200 cursor-pointer">
            上传 PDF / Word 简历
          </label>
        </Card>
      ) : (
        <div className="space-y-2">
          {resumes.map((resume) => (
            <Card
              key={resume.id}
              className="flex items-start gap-3 p-3 cursor-pointer hover:bg-surface-dark"
              onClick={() => setSelectedResume(resume)}
            >
              <div className={`w-10 h-10 rounded-lg flex items-center justify-center ${
                resume.isDefault ? 'bg-surface-dark' : 'bg-surface-light'
              }`}>
                <FileText className={`w-5 h-5 ${resume.isDefault ? 'text-primary-light' : 'text-text-muted'}`} />
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <p className="text-sm font-medium text-text-primary truncate">{resume.name}</p>
                  {resume.isDefault && (
                    <Star className="w-3 h-3 text-warning" />
                  )}
                </div>
                <p className="text-xs text-text-muted mt-0.5">
                  {resume.structuredData.skills.length}个技能 · {formatDate(resume.createdAt)}
                </p>
                {resume.aiAnalysis && (
                  <div className="flex items-center gap-2 mt-2">
                    <Progress
                      value={resume.aiAnalysis.overallScore}
                      color={getScoreColor(resume.aiAnalysis.overallScore)}
                      className="flex-1"
                    />
                    <span className="text-xs font-medium" style={{ color: getScoreColor(resume.aiAnalysis.overallScore) }}>
                      {resume.aiAnalysis.overallScore}分
                    </span>
                  </div>
                )}
              </div>
              <div className="flex items-center gap-1">
                {!resume.isDefault && (
                  <button
                    onClick={(e) => { e.stopPropagation(); handleSetDefault(resume.id) }}
                    className="p-1 text-text-muted hover:text-warning"
                    title="设为默认"
                  >
                    <Star className="w-4 h-4" />
                  </button>
                )}
                <button
                  onClick={(e) => { e.stopPropagation(); handleDelete(resume.id) }}
                  className="p-1 text-text-muted hover:text-danger"
                  title="删除"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
            </Card>
          ))}
        </div>
      )}

      {/* ====== 岗位匹配分析 ====== */}
      <div className="border-t border-surface-hairline pt-4 space-y-3">
        <h2 className="text-lg font-medium gradient-text flex items-center gap-2">
          <Search className="w-4 h-4" />
          岗位匹配分析
        </h2>
        <p className="text-xs text-text-muted">
          填写职位描述，选择简历，AI 将分析匹配度并给出改进建议
        </p>

        {/* Resume selector */}
        {resumes.length > 0 ? (
          <div className="relative">
            <select
              value={matchResumeId}
              onChange={(e) => setMatchResumeId(e.target.value)}
              className="w-full rounded-xl bg-surface-dark border border-surface-hairline px-3 py-2 text-sm text-text-primary appearance-none cursor-pointer focus:outline-none focus:border-surface-hairline"
            >
              <option value="">选择要匹配的简历...</option>
              {resumes.map(r => (
                <option key={r.id} value={r.id}>
                  {r.name} {r.isDefault ? '(默认)' : ''} — {r.structuredData.skills.length}个技能
                </option>
              ))}
            </select>
            <ChevronDown className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-text-muted pointer-events-none" />
          </div>
        ) : (
          <p className="text-xs text-text-muted">请先上传简历</p>
        )}

        {/* JD textarea */}
        <textarea
          placeholder="在此粘贴职位描述（JD），包括职位要求、技能要求、工作职责等..."
          value={jdText}
          onChange={(e) => setJdText(e.target.value)}
          rows={5}
          className="w-full rounded-xl bg-surface-dark border border-surface-hairline px-3 py-2 text-sm text-text-primary placeholder:text-text-muted resize-none focus:outline-none focus:border-surface-hairline"
        />

        {/* Buttons */}
        <div className="flex gap-2">
          {!streaming ? (
            <Button
              size="sm"
              className="flex-1"
              onClick={handleJobMatch}
              disabled={!matchResumeId || !jdText.trim()}
            >
              <Bot className="w-3.5 h-3.5" />
              AI 分析匹配度
            </Button>
          ) : (
            <Button size="sm" className="flex-1" onClick={handleCancelMatch}>
              <XCircle className="w-3.5 h-3.5" />
              取消分析
            </Button>
          )}
        </div>

        {/* Match error */}
        {matchError && (
          <Card className="p-3 border-danger/20">
            <p className="text-xs text-danger flex items-start gap-1">
              <AlertCircle className="w-3 h-3 mt-0.5 shrink-0" />
              {matchError}
            </p>
          </Card>
        )}

        {/* Streaming text */}
        {streaming && streamText && (
          <Card className="p-3 max-h-[250px] overflow-y-auto">
            <p className="text-xs text-text-secondary whitespace-pre-wrap leading-relaxed">
              {streamText}
              <span className="inline-block w-1.5 h-4 bg-primary-light ml-0.5 align-middle" />
            </p>
            <div ref={streamEndRef} />
          </Card>
        )}

        {/* Structured result */}
        {matchResult && !streaming && (
          <Card className="p-4 space-y-4">
            {/* Score */}
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium text-text-primary">匹配评分</span>
              <span className="text-2xl font-medium" style={{ color: getScoreColor(matchResult.overallScore) }}>
                {matchResult.overallScore}
                <span className="text-sm font-normal text-text-muted ml-1">分</span>
              </span>
            </div>
            <Progress value={matchResult.overallScore} color={getScoreColor(matchResult.overallScore)} />

            {/* Recommendation */}
            {matchResult.recommendation && (
              <p className="text-xs text-text-secondary leading-relaxed">
                {matchResult.recommendation}
              </p>
            )}

            {/* Skill Match */}
            {matchResult.skillMatch.length > 0 && (
              <div>
                <p className="text-xs font-medium text-success mb-1.5 flex items-center gap-1">
                  <CheckCircle className="w-3 h-3" /> 匹配技能
                </p>
                <div className="flex flex-wrap gap-1">
                  {matchResult.skillMatch.map((s, i) => (
                    <Badge key={i} variant="success">{s}</Badge>
                  ))}
                </div>
              </div>
            )}

            {/* Skill Gap */}
            {matchResult.skillGap.length > 0 && (
              <div>
                <p className="text-xs font-medium text-warning mb-1.5 flex items-center gap-1">
                  <AlertCircle className="w-3 h-3" /> 技能差距
                </p>
                <div className="flex flex-wrap gap-1">
                  {matchResult.skillGap.map((s, i) => (
                    <Badge key={i} variant="warning">{s}</Badge>
                  ))}
                </div>
              </div>
            )}

            {/* Strengths */}
            {matchResult.strengths.length > 0 && (
              <div>
                <p className="text-xs font-medium text-success mb-1.5">优势</p>
                {matchResult.strengths.map((s, i) => (
                  <p key={i} className="text-xs text-text-secondary flex items-start gap-1 mb-0.5">
                    <CheckCircle className="w-3 h-3 text-success mt-0.5 shrink-0" /> {s}
                  </p>
                ))}
              </div>
            )}

            {/* Weaknesses */}
            {matchResult.weaknesses.length > 0 && (
              <div>
                <p className="text-xs font-medium text-danger mb-1.5">劣势</p>
                {matchResult.weaknesses.map((s, i) => (
                  <p key={i} className="text-xs text-text-secondary flex items-start gap-1 mb-0.5">
                    <AlertCircle className="w-3 h-3 text-danger mt-0.5 shrink-0" /> {s}
                  </p>
                ))}
              </div>
            )}

            {/* Improvement suggestions */}
            {matchResult.improvementSuggestions.length > 0 && (
              <div>
                <p className="text-xs font-medium text-primary-light mb-1.5">改进建议</p>
                {matchResult.improvementSuggestions.map((s, i) => (
                  <p key={i} className="text-xs text-text-secondary flex items-start gap-1 mb-0.5">
                    <span className="w-4 h-4 rounded-full bg-surface-dark text-primary-light flex items-center justify-center text-xs shrink-0 mt-0.5">{i + 1}</span>
                    {s}
                  </p>
                ))}
              </div>
            )}
          </Card>
        )}
      </div>

      {/* ====== 分析历史 ====== */}
      {history.length > 0 && (
        <div className="border-t border-surface-hairline pt-4 space-y-2">
          <h2 className="text-sm font-medium gradient-text flex items-center gap-2">
            <Clock className="w-3.5 h-3.5" />
            分析历史
          </h2>
          {history.slice(0, 10).map((record) => (
            <Card key={record.id} className="p-3 space-y-2">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2 min-w-0">
                  <TrendingUp className="w-3.5 h-3.5 text-primary-light shrink-0" />
                  <span className="text-xs text-text-primary truncate">
                    {record.jobTitle || '未命名岗位'}
                  </span>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <span className="text-xs font-medium" style={{ color: getScoreColor(record.result.overallScore) }}>
                    {record.result.overallScore}分
                  </span>
                  <button
                    onClick={async () => { await deleteMatchAnalysis(record.id); await loadHistory() }}
                    className="p-0.5 text-text-muted hover:text-danger"
                    title="删除"
                  >
                    <Trash2 className="w-3 h-3" />
                  </button>
                </div>
              </div>
              <div className="flex items-center gap-2 text-xs text-text-muted">
                <span>{record.resumeName}</span>
                <span>·</span>
                <span>{formatDate(record.createdAt)}</span>
              </div>
              {/* 点击展开详情 */}
              <details className="group">
                <summary className="text-xs text-primary-light cursor-pointer hover:text-primary-lighter">
                  查看详情
                </summary>
                <div className="mt-2 space-y-2 text-xs">
                  <p className="text-text-secondary line-clamp-3 whitespace-pre-wrap">
                    {record.jobDescription.slice(0, 300)}
                  </p>
                  {record.result.skillMatch.length > 0 && (
                    <div className="flex flex-wrap gap-1">
                      {record.result.skillMatch.map(s => (
                        <Badge key={s} variant="success">{s}</Badge>
                      ))}
                    </div>
                  )}
                  {record.result.skillGap.length > 0 && (
                    <div className="flex flex-wrap gap-1">
                      {record.result.skillGap.map(s => (
                        <Badge key={s} variant="warning">{s}</Badge>
                      ))}
                    </div>
                  )}
                  <p className="text-text-secondary">{record.result.recommendation}</p>
                </div>
              </details>
            </Card>
          ))}
        </div>
      )}

      {/* Resume Detail Dialog */}
      <Dialog
        open={!!selectedResume}
        onClose={() => { setSelectedResume(null); setEditing(false); setEditForm(null); setNewSkill('') }}
        title="简历详情"
      >
        {selectedResume && (
          <div className="space-y-4">
            {/* 操作栏：查看/编辑切换 */}
            <div className="flex items-center justify-between">
              <span className="text-xs text-text-muted">
                {editing ? '编辑模式：修改后点击「保存修改」，评分将立即使用新数据' : '查看模式'}
              </span>
              {!editing ? (
                <Button size="sm" onClick={() => startEdit(selectedResume)}>
                  <Pencil className="w-3.5 h-3.5" />
                  编辑简历
                </Button>
              ) : (
                <div className="flex gap-2">
                  <Button size="sm" variant="secondary" onClick={cancelEdit}>
                    <X className="w-3.5 h-3.5" />
                    取消
                  </Button>
                  <Button size="sm" onClick={saveEdit}>
                    <Save className="w-3.5 h-3.5" />
                    保存修改
                  </Button>
                </div>
              )}
            </div>

            {editing && editForm ? (
              /* ===== 编辑模式 ===== */
              <div className="space-y-4">
                {/* 基本信息 */}
                <div>
                  <p className="text-xs font-medium text-text-secondary mb-2">基本信息</p>
                  <div className="grid grid-cols-2 gap-2">
                    <label className="block">
                      <span className="text-xs text-text-muted">姓名</span>
                      <input
                        className="w-full rounded-xl bg-surface-dark border border-surface-hairline px-3 py-2 text-sm text-text-primary focus:outline-none focus:border-surface-hairline"
                        value={editForm.name}
                        onChange={(e) => updateEditField('name', e.target.value)}
                      />
                    </label>
                    <label className="block">
                      <span className="text-xs text-text-muted">工作年限（年）</span>
                      <input
                        type="number" min="0" step="0.5"
                        className="w-full rounded-xl bg-surface-dark border border-surface-hairline px-3 py-2 text-sm text-text-primary focus:outline-none focus:border-surface-hairline"
                        value={editForm.yearsOfExperience || 0}
                        onChange={(e) => updateEditField('yearsOfExperience', Math.max(0, Number(e.target.value) || 0))}
                      />
                    </label>
                    <label className="block">
                      <span className="text-xs text-text-muted">电话</span>
                      <input
                        className="w-full rounded-xl bg-surface-dark border border-surface-hairline px-3 py-2 text-sm text-text-primary focus:outline-none focus:border-surface-hairline"
                        value={editForm.phone}
                        onChange={(e) => updateEditField('phone', e.target.value)}
                      />
                    </label>
                    <label className="block">
                      <span className="text-xs text-text-muted">邮箱</span>
                      <input
                        className="w-full rounded-xl bg-surface-dark border border-surface-hairline px-3 py-2 text-sm text-text-primary focus:outline-none focus:border-surface-hairline"
                        value={editForm.email}
                        onChange={(e) => updateEditField('email', e.target.value)}
                      />
                    </label>
                    <label className="block col-span-2">
                      <span className="text-xs text-text-muted">城市</span>
                      <input
                        className="w-full rounded-xl bg-surface-dark border border-surface-hairline px-3 py-2 text-sm text-text-primary focus:outline-none focus:border-surface-hairline"
                        value={editForm.city}
                        onChange={(e) => updateEditField('city', e.target.value)}
                      />
                    </label>
                  </div>
                </div>

                {/* 技能标签 */}
                <div>
                  <p className="text-xs font-medium text-text-secondary mb-1.5">技能标签（直接参与岗位匹配）</p>
                  <div className="flex flex-wrap gap-1.5 mb-2">
                    {editForm.skills.map((s) => (
                      <span key={s} className="inline-flex items-center gap-1 px-2 py-1 text-xs rounded-lg bg-surface-dark text-primary-light">
                        {s}
                        <button onClick={() => removeSkill(s)} className="text-text-muted hover:text-danger" title="删除技能">
                          <X className="w-3 h-3" />
                        </button>
                      </span>
                    ))}
                    {editForm.skills.length === 0 && (
                      <span className="text-xs text-text-muted">暂无技能，可手动添加</span>
                    )}
                  </div>
                  <div className="flex gap-2">
                    <input
                      className="flex-1 rounded-xl bg-surface-dark border border-surface-hairline px-3 py-2 text-sm text-text-primary focus:outline-none focus:border-surface-hairline"
                      placeholder="输入技能后回车添加，如：Vue、Java"
                      value={newSkill}
                      onChange={(e) => setNewSkill(e.target.value)}
                      onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addSkill() } }}
                    />
                    <Button size="sm" variant="secondary" onClick={addSkill}>
                      <Plus className="w-3.5 h-3.5" />
                      添加
                    </Button>
                  </div>
                </div>

                {/* 学历 */}
                {editForm.education.map((edu, i) => (
                  <div key={i}>
                    <p className="text-xs font-medium text-text-secondary mb-2">学历 {i + 1}</p>
                    <div className="grid grid-cols-3 gap-2">
                      <label className="block">
                        <span className="text-xs text-text-muted">学校</span>
                        <input
                          className="w-full rounded-xl bg-surface-dark border border-surface-hairline px-3 py-2 text-sm text-text-primary focus:outline-none focus:border-surface-hairline"
                          value={edu.school}
                          onChange={(e) => updateEducation(i, 'school', e.target.value)}
                        />
                      </label>
                      <label className="block">
                        <span className="text-xs text-text-muted">学历</span>
                        <input
                          className="w-full rounded-xl bg-surface-dark border border-surface-hairline px-3 py-2 text-sm text-text-primary focus:outline-none focus:border-surface-hairline"
                          value={edu.degree}
                          onChange={(e) => updateEducation(i, 'degree', e.target.value)}
                        />
                      </label>
                      <label className="block">
                        <span className="text-xs text-text-muted">专业</span>
                        <input
                          className="w-full rounded-xl bg-surface-dark border border-surface-hairline px-3 py-2 text-sm text-text-primary focus:outline-none focus:border-surface-hairline"
                          value={edu.major}
                          onChange={(e) => updateEducation(i, 'major', e.target.value)}
                        />
                      </label>
                    </div>
                  </div>
                ))}

                {/* 工作经历 */}
                {editForm.workExperience.map((work, i) => (
                  <div key={i}>
                    <p className="text-xs font-medium text-text-secondary mb-2">工作经历 {i + 1}</p>
                    <div className="grid grid-cols-2 gap-2">
                      <label className="block">
                        <span className="text-xs text-text-muted">公司</span>
                        <input
                          className="w-full rounded-xl bg-surface-dark border border-surface-hairline px-3 py-2 text-sm text-text-primary focus:outline-none focus:border-surface-hairline"
                          value={work.company}
                          onChange={(e) => updateWork(i, 'company', e.target.value)}
                        />
                      </label>
                      <label className="block">
                        <span className="text-xs text-text-muted">职位</span>
                        <input
                          className="w-full rounded-xl bg-surface-dark border border-surface-hairline px-3 py-2 text-sm text-text-primary focus:outline-none focus:border-surface-hairline"
                          value={work.position}
                          onChange={(e) => updateWork(i, 'position', e.target.value)}
                        />
                      </label>
                    </div>
                    <label className="block mt-2">
                      <span className="text-xs text-text-muted">工作内容 / 职责</span>
                      <textarea
                        rows={2}
                        className="w-full rounded-xl bg-surface-dark border border-surface-hairline px-3 py-2 text-sm text-text-primary focus:outline-none focus:border-surface-hairline resize-none"
                        value={work.description}
                        onChange={(e) => updateWork(i, 'description', e.target.value)}
                      />
                    </label>
                  </div>
                ))}

                {/* 个人简介 */}
                <label className="block">
                  <span className="text-xs text-text-muted">个人简介 / Summary</span>
                  <textarea
                    rows={2}
                    className="w-full rounded-xl bg-surface-dark border border-surface-hairline px-3 py-2 text-sm text-text-primary focus:outline-none focus:border-surface-hairline resize-none"
                    value={editForm.summary}
                    onChange={(e) => updateEditField('summary', e.target.value)}
                  />
                </label>
              </div>
            ) : (
              /* ===== 查看模式 ===== */
              <>
                {/* Basic info */}
                <div className="grid grid-cols-2 gap-2">
                  {selectedResume.structuredData.name && (
                    <div className="surface-card p-2">
                      <p className="text-xs text-text-muted">姓名</p>
                      <p className="text-sm font-medium">{selectedResume.structuredData.name}</p>
                    </div>
                  )}
                  {selectedResume.structuredData.email && (
                    <div className="surface-card p-2">
                      <p className="text-xs text-text-muted">邮箱</p>
                      <p className="text-xs truncate">{selectedResume.structuredData.email}</p>
                    </div>
                  )}
                  {selectedResume.structuredData.phone && (
                    <div className="surface-card p-2">
                      <p className="text-xs text-text-muted">电话</p>
                      <p className="text-sm font-medium">{selectedResume.structuredData.phone}</p>
                    </div>
                  )}
                  {selectedResume.structuredData.city && (
                    <div className="surface-card p-2">
                      <p className="text-xs text-text-muted">城市</p>
                      <p className="text-sm font-medium">{selectedResume.structuredData.city}</p>
                    </div>
                  )}
                </div>

                {/* Skills */}
                {selectedResume.structuredData.skills.length > 0 && (
                  <div>
                    <p className="text-xs font-medium text-text-secondary mb-1.5 flex items-center gap-1">
                      <Code className="w-3 h-3" /> 技能标签
                    </p>
                    <div className="flex flex-wrap gap-1">
                      {selectedResume.structuredData.skills.map((s) => (
                        <Badge key={s} variant="default">{s}</Badge>
                      ))}
                    </div>
                  </div>
                )}

                {/* AI Analysis */}
                {selectedResume.aiAnalysis ? (
                  <div className="space-y-3">
                    <div className="flex items-center gap-3">
                      <Progress
                        value={selectedResume.aiAnalysis.overallScore}
                        color={getScoreColor(selectedResume.aiAnalysis.overallScore)}
                        className="flex-1"
                      />
                      <span className="text-lg font-medium" style={{ color: getScoreColor(selectedResume.aiAnalysis.overallScore) }}>
                        {selectedResume.aiAnalysis.overallScore}
                      </span>
                    </div>

                    {selectedResume.aiAnalysis.strengths.length > 0 && (
                      <div>
                        <p className="text-xs font-medium text-success mb-1">优势</p>
                        {selectedResume.aiAnalysis.strengths.map((s, i) => (
                          <p key={i} className="text-xs text-text-secondary flex items-start gap-1">
                            <CheckCircle className="w-3 h-3 text-success mt-0.5 shrink-0" /> {s}
                          </p>
                        ))}
                      </div>
                    )}

                    {selectedResume.aiAnalysis.weaknesses.length > 0 && (
                      <div>
                        <p className="text-xs font-medium text-danger mb-1">不足</p>
                        {selectedResume.aiAnalysis.weaknesses.map((s, i) => (
                          <p key={i} className="text-xs text-text-secondary flex items-start gap-1">
                            <AlertCircle className="w-3 h-3 text-danger mt-0.5 shrink-0" /> {s}
                          </p>
                        ))}
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="text-center py-4">
                    <p className="text-xs text-text-muted mb-3">尚未分析简历</p>
                    <Button size="sm" onClick={() => handleAnalyze(selectedResume)} loading={loading}>
                      <Eye className="w-3.5 h-3.5" />
                      AI 分析简历
                    </Button>
                  </div>
                )}
              </>
            )}
          </div>
        )}
      </Dialog>

      <div id="candidate-preferences" className="pt-2 border-t border-surface-hairline">
        <CandidatePreferencesCard onNotify={showToast} />
      </div>

      <Toast {...toast} onClose={() => setToast({ ...toast, visible: false })} />
    </div>
  )
}
