/** 掌握度控件：5 段颜色条 + 百分比；可点击时每段都是独立按钮。 */
const LEVELS = ['刚接触', '能复述', '能解释', '能应用', '能迁移'] as const

export function Mastery({
  value,
  onChange,
  compact = false,
}: {
  value: number
  onChange?: (value: number) => void
  compact?: boolean
}) {
  const safe = Math.min(5, Math.max(0, Math.round(value)))
  const percent = safe * 20
  const label = safe === 0 ? '未评估' : `${safe}/5 · ${percent}%`

  return (
    <span
      className={`atlas-mastery ${compact ? 'is-compact' : ''} ${safe > 0 ? `level-${safe}` : ''}`}
      title={`掌握度 ${label}`}
    >
      {compact ? null : <span className="atlas-mastery-label">掌握 {label}</span>}
      <span className="atlas-mastery-meter" role="group" aria-label={`掌握度 ${safe}/5`}>
        {LEVELS.map((name, index) => {
          const level = index + 1
          const className = `atlas-mastery-seg ${level <= safe ? 'is-on' : ''}`
          return onChange ? (
            <button
              key={level}
              type="button"
              className={className}
              title={`${level}/5 · ${level * 20}%：${name}`}
              aria-label={`${level} 级：${name}`}
              onClick={() => onChange(level === safe ? level - 1 : level)}
            />
          ) : (
            <i key={level} className={className} />
          )
        })}
      </span>
    </span>
  )
}
