import React, { useState, useEffect } from 'react'
import { Card } from '../../components/ui/card'
import { Button } from '../../components/ui/button'
import { Dialog } from '../../components/ui/dialog'
import { getInterviewEvents, saveInterviewEvent, deleteInterviewEvent } from '../../shared/db/interview-store'
import type { InterviewEvent } from '../../shared/db'
import { formatDate } from '../../shared/utils/date'
import { CalendarDays, MapPin, Plus, Trash2, Bell } from 'lucide-react'

const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六']
const MONTHS = ['1月', '2月', '3月', '4月', '5月', '6月', '7月', '8月', '9月', '10月', '11月', '12月']

export default function InterviewCalendar() {
  const [events, setEvents] = useState<InterviewEvent[]>([])
  const [currentDate, setCurrentDate] = useState(new Date())
  const [showDialog, setShowDialog] = useState(false)
  const [newEvent, setNewEvent] = useState({
    applicationId: '',
    companyName: '',
    jobTitle: '',
    interviewDate: '',
    location: '',
    notes: '',
  })

  useEffect(() => {
    loadEvents()
  }, [])

  async function loadEvents() {
    const evts = await getInterviewEvents()
    setEvents(evts)
  }

  const year = currentDate.getFullYear()
  const month = currentDate.getMonth()

  const firstDay = new Date(year, month, 1).getDay()
  const daysInMonth = new Date(year, month + 1, 0).getDate()

  const days: (number | null)[] = []
  for (let i = 0; i < firstDay; i++) days.push(null)
  for (let i = 1; i <= daysInMonth; i++) days.push(i)

  function getEventsForDay(day: number) {
    return events.filter((e) => {
      const d = new Date(e.interviewDate)
      return d.getFullYear() === year && d.getMonth() === month && d.getDate() === day
    })
  }

  function prevMonth() {
    setCurrentDate(new Date(year, month - 1, 1))
  }

  function nextMonth() {
    setCurrentDate(new Date(year, month + 1, 1))
  }

  async function handleSave() {
    if (!newEvent.companyName || !newEvent.interviewDate) return
    await saveInterviewEvent({
      applicationId: Date.now().toString(),
      companyName: newEvent.companyName,
      jobTitle: newEvent.jobTitle || '面试',
      interviewDate: newEvent.interviewDate,
      location: newEvent.location,
      notes: newEvent.notes,
    })
    setShowDialog(false)
    setNewEvent({ applicationId: '', companyName: '', jobTitle: '', interviewDate: '', location: '', notes: '' })
    await loadEvents()
  }

  async function handleDelete(id: string) {
    await deleteInterviewEvent(id)
    await loadEvents()
  }

  const upcoming = events
    .filter((e) => new Date(e.interviewDate) >= new Date())
    .sort((a, b) => new Date(a.interviewDate).getTime() - new Date(b.interviewDate).getTime())

  return (
    <div className="space-y-8">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold gradient-text">面试日历</h1>
          <p className="text-sm text-text-muted mt-1">管理和追踪面试安排</p>
        </div>
        <Button onClick={() => setShowDialog(true)}>
          <Plus className="w-4 h-4" />
          添加面试
        </Button>
      </div>

      <div className="grid grid-cols-3 gap-4">
        {/* Calendar */}
        <div className="col-span-2">
          <Card className="p-6">
            <div className="flex items-center justify-between mb-6">
              <button onClick={prevMonth} className="text-text-muted hover:text-text-primary">&lt;</button>
              <h2 className="text-lg font-bold">{year}年 {MONTHS[month]}</h2>
              <button onClick={nextMonth} className="text-text-muted hover:text-text-primary">&gt;</button>
            </div>

            <div className="grid grid-cols-7 gap-1">
              {WEEKDAYS.map((d) => (
                <div key={d} className="text-center text-xs text-text-muted py-2">{d}</div>
              ))}
              {days.map((day, i) => {
                const dayEvents = day ? getEventsForDay(day) : []
                const isToday = day && year === new Date().getFullYear() &&
                  month === new Date().getMonth() && day === new Date().getDate()

                return (
                  <div
                    key={i}
                    className={`aspect-square rounded-lg flex flex-col items-center justify-start p-1 text-sm ${
                      !day ? '' : isToday
                        ? 'bg-primary/20 text-primary-light font-bold'
                        : 'hover:bg-white/5 text-text-secondary'
                    } ${dayEvents.length > 0 ? 'cursor-pointer' : ''}`}
                  >
                    {day && (
                      <>
                        <span>{day}</span>
                        {dayEvents.length > 0 && (
                          <div className="flex gap-0.5 mt-0.5">
                            {dayEvents.map((_, j) => (
                              <div key={j} className="w-1.5 h-1.5 rounded-full bg-success" />
                            ))}
                          </div>
                        )}
                      </>
                    )}
                  </div>
                )
              })}
            </div>
          </Card>
        </div>

        {/* Upcoming Interviews */}
        <div>
          <h3 className="text-sm font-semibold text-text-primary mb-3 flex items-center gap-2">
            <Bell className="w-4 h-4 text-warning" />
            即将到来的面试
          </h3>
          <div className="space-y-2 max-h-[500px] overflow-y-auto">
            {upcoming.length === 0 ? (
              <p className="text-xs text-text-muted text-center py-6">暂无安排的面试</p>
            ) : (
              upcoming.map((event) => (
                <Card key={event.id} className="p-3">
                  <div className="flex items-start justify-between">
                    <div>
                      <p className="text-sm font-medium text-text-primary">{event.jobTitle}</p>
                      <p className="text-xs text-text-muted">{event.companyName}</p>
                    </div>
                    <button
                      onClick={() => handleDelete(event.id)}
                      className="text-text-muted hover:text-danger"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                  <div className="mt-2 space-y-1">
                    <p className="text-xs text-text-secondary flex items-center gap-1">
                      <CalendarDays className="w-3 h-3 text-primary-light" />
                      {formatDate(event.interviewDate)}
                    </p>
                    {event.location && (
                      <p className="text-xs text-text-secondary flex items-center gap-1">
                        <MapPin className="w-3 h-3 text-info" />
                        {event.location}
                      </p>
                    )}
                  </div>
                  {event.notes && (
                    <p className="text-xs text-text-muted mt-1 border-t border-white/5 pt-1">{event.notes}</p>
                  )}
                </Card>
              ))
            )}
          </div>
        </div>
      </div>

      {/* Add Interview Dialog */}
      <Dialog open={showDialog} onClose={() => setShowDialog(false)} title="添加面试安排">
        <div className="space-y-3">
          <div>
            <label className="text-xs text-text-muted mb-1 block">公司名称 *</label>
            <input
              type="text"
              value={newEvent.companyName}
              onChange={(e) => setNewEvent({ ...newEvent, companyName: e.target.value })}
              className="input-field"
              placeholder="输入公司名称"
            />
          </div>
          <div>
            <label className="text-xs text-text-muted mb-1 block">岗位名称</label>
            <input
              type="text"
              value={newEvent.jobTitle}
              onChange={(e) => setNewEvent({ ...newEvent, jobTitle: e.target.value })}
              className="input-field"
              placeholder="输入岗位名称"
            />
          </div>
          <div>
            <label className="text-xs text-text-muted mb-1 block">面试时间 *</label>
            <input
              type="datetime-local"
              value={newEvent.interviewDate}
              onChange={(e) => setNewEvent({ ...newEvent, interviewDate: e.target.value })}
              className="input-field"
            />
          </div>
          <div>
            <label className="text-xs text-text-muted mb-1 block">地点</label>
            <input
              type="text"
              value={newEvent.location}
              onChange={(e) => setNewEvent({ ...newEvent, location: e.target.value })}
              className="input-field"
              placeholder="面试地点或线上链接"
            />
          </div>
          <div>
            <label className="text-xs text-text-muted mb-1 block">备注</label>
            <textarea
              value={newEvent.notes}
              onChange={(e) => setNewEvent({ ...newEvent, notes: e.target.value })}
              className="input-field min-h-[80px]"
              placeholder="面试注意事项..."
            />
          </div>
          <Button className="w-full" onClick={handleSave}>
            <Plus className="w-4 h-4" />
            保存
          </Button>
        </div>
      </Dialog>
    </div>
  )
}
