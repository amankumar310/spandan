import Badge from '../models/Badge.js'
import UserAchievement from '../models/UserAchievement.js'
import UserRoomStats from '../models/UserRoomStats.js'
import UserLifetimeStats from '../models/UserLifetimeStats.js'
import Room from '../models/Room.js'
import { checkRule } from './ruleEvaluator.js'
import { updateRoomStats, updateLifetimeStats } from './statsService.js'

async function evaluateBadges(userId, roomCode, stats, scope) {
  const badges = await Badge.find({ scope }).lean()
  if (!badges.length) return []

  const filter = { userId, badgeId: { $in: badges.map(b => b._id) }, scope }
  if (scope === 'section') filter.roomCode = roomCode
  const earned = await UserAchievement.find(filter).select('badgeId').lean()
  const earnedIds = new Set(earned.map(a => String(a.badgeId)))
  const newlyUnlocked = []

  for (const badge of badges) {
    if (earnedIds.has(String(badge._id)) || !checkRule(badge.rule, stats)) continue
    try {
      const achievement = await UserAchievement.create({
        userId, badgeId: badge._id, scope, roomCode: scope === 'section' ? roomCode : null
      })
      newlyUnlocked.push({ ...achievement.toObject(), badgeId: badge })
    } catch (err) {
      if (err?.code !== 11000) throw err
    }
  }
  return newlyUnlocked
}

export async function processAnswerAchievement({ roomId, userId, isCorrect, responseTime, points }) {
  const room = await Room.findById(roomId).select('code name').lean()
  if (!room?.code) return { stats: null, lifetimeStats: null, badges: [], roomCode: null }

  const [sectionStats, lifetimeStats] = await Promise.all([
    updateRoomStats({ userId, roomCode: room.code, isCorrect, responseTime, points }),
    updateLifetimeStats({ userId, isCorrect, responseTime, points })
  ])

  const [sectionBadges, lifetimeBadges] = await Promise.all([
    evaluateBadges(userId, room.code, sectionStats, 'section'),
    evaluateBadges(userId, room.code, lifetimeStats, 'lifetime')
  ])

  return {
    stats: sectionStats,
    lifetimeStats,
    badges: [...sectionBadges, ...lifetimeBadges],
    roomCode: room.code
  }
}

export async function syncEligibleAchievements(userId, roomCode = null) {
  const normalizedRoomCode = roomCode ? String(roomCode).toUpperCase() : null
  if (normalizedRoomCode) {
    const stats = await UserRoomStats.findOne({ userId, roomCode: normalizedRoomCode }).lean()
    if (stats) await evaluateBadges(userId, normalizedRoomCode, stats, 'section')
    return
  }

  const stats = await UserLifetimeStats.findOne({ userId }).lean()
  if (stats) await evaluateBadges(userId, null, stats, 'lifetime')
}

export async function getUserAchievements(userId) {
  // Also evaluate existing stats so badges earned before the v2 achievement
  // engine was installed are backfilled when the page is opened.
  await syncEligibleAchievements(userId)

  const [achievedBadges, allBadges] = await Promise.all([
    UserAchievement.find({ userId, scope: 'lifetime' }).populate('badgeId').sort({ earnedAt: -1 }).lean(),
    Badge.find({ scope: 'lifetime' }).sort({ category: 1, name: 1 }).lean()
  ])
  const seen = new Set()
  const achieved = achievedBadges.filter(a => {
    const id = a?.badgeId?._id
    if (!id || seen.has(String(id))) return false
    seen.add(String(id)); return true
  })
  return { achievedBadges: achieved, unachievedBadges: allBadges.filter(b => !seen.has(String(b._id))) }
}

export async function getSectionAchievements(userId, roomCode) {
  await syncEligibleAchievements(userId, roomCode)

  const [achievedBadges, allBadges, stats] = await Promise.all([
    UserAchievement.find({ userId, scope: 'section', roomCode }).populate('badgeId').sort({ earnedAt: -1 }).lean(),
    Badge.find({ scope: 'section' }).sort({ category: 1, name: 1 }).lean(),
    UserRoomStats.findOne({ userId, roomCode }).lean()
  ])
  const seen = new Set()
  const achieved = achievedBadges.filter(a => {
    const id = a?.badgeId?._id
    if (!id || seen.has(String(id))) return false
    seen.add(String(id)); return true
  })
  return {
    roomCode,
    stats: stats || { totalAnswers: 0, correctAnswers: 0, firstAnswersCorrect: 0, currentStreak: 0, maxStreak: 0, accuracy: 0, fastestResponse: null, fastAnswers5: 0, fastAnswers10: 0, totalPoints: 0 },
    achievedBadges: achieved,
    unachievedBadges: allBadges.filter(b => !seen.has(String(b._id)))
  }
}

export async function getAchievementProgress(userId) {
  await syncEligibleAchievements(userId)
  const [earnedIds, total] = await Promise.all([
    UserAchievement.distinct('badgeId', { userId, scope: 'lifetime' }),
    Badge.countDocuments({ scope: 'lifetime' })
  ])
  const earned = earnedIds.length
  return { earned, total, percent: total > 0 ? Math.round((earned / total) * 100) : 0 }
}

export async function getAchievementOverview(userId) {
  const sections = await UserRoomStats.find({ userId }).sort({ updatedAt: -1 }).limit(20).lean()
  const rooms = await Room.find({ code: { $in: sections.map(s => s.roomCode) } }).select('code name endedAt createdAt').lean()
  const roomMap = new Map(rooms.map(r => [r.code, r]))
  return sections.map(s => ({ ...s, room: roomMap.get(s.roomCode) || { code: s.roomCode, name: s.roomCode } }))
}

export async function awardSectionChampion(roomCode) {
  const badge = await Badge.findOne({ name: 'Section Champion', scope: 'section' }).lean()
  if (!badge) return null
  const top = await UserRoomStats.findOne({ roomCode })
    .sort({ totalPoints: -1, correctAnswers: -1, totalAnswers: -1, updatedAt: 1 })
    .lean()
  if (!top) return null
  const exists = await UserAchievement.exists({ userId: top.userId, badgeId: badge._id, scope: 'section', roomCode })
  if (exists) return null
  try {
    const achievement = await UserAchievement.create({ userId: top.userId, badgeId: badge._id, scope: 'section', roomCode })
    return { userId: String(top.userId), badge: { ...achievement.toObject(), badgeId: badge } }
  } catch (err) {
    if (err?.code === 11000) return null
    throw err
  }
}
