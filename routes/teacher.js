const express = require('express');
const router = express.Router();
const db = require('../db'); 

// MIDDLEWARE: Proteksyon para tanging Guro lang ang makapasok
function isTeacher(req, res, next) {
    if (req.isAuthenticated() && req.user.role === 'Teacher') {
        return next();
    }
    res.status(403).send("Access Denied: Teachers Only");
}

router.get('/dashboard', isTeacher, async (req, res) => {
    const teacherId = req.user.user_id;

    try {
        // Mahalaga: Ang pagkakasunod-sunod dito ay dapat kapareho ng queries sa Promise.all
        const [
            [classes], 
            [statsResult], 
            [recentScores], 
            [forumActivity],
            [pendingAssessments], 
            [needsAttention], 
            [announcements], 
            [pinnedDiscussions], 
            [events]
        ] = await Promise.all([
            // 1. Handled Subjects & Active Classes
            db.query(`
                SELECT c.*, s.subject_name, s.subject_code, s.subject_image,
                (SELECT COUNT(*) FROM class_students cs WHERE cs.class_id = c.class_id) as student_count
                FROM classes c JOIN subjects s ON c.subject_id = s.subject_id
                WHERE c.teacher_id = ?`, [teacherId]),

            // 2. Dashboard Stats
            db.query(`
                SELECT 
                    (SELECT COUNT(DISTINCT student_id) FROM class_students cs JOIN classes c ON cs.class_id = c.class_id WHERE c.teacher_id = ?) as totalStudents,
                    (SELECT COUNT(*) FROM forum_topics WHERE teacher_id = ?) as totalForums,
                    (SELECT COUNT(*) FROM student_scores ss 
                     JOIN assessments a ON ss.assessment_id = a.assessment_id 
                     JOIN topics t ON a.topic_id = t.topic_id 
                     JOIN quarters q ON t.quarter_id = q.quarter_id 
                     JOIN classes c ON q.subject_id = c.subject_id 
                     WHERE c.teacher_id = ?) as totalAttempts`,
                [teacherId, teacherId, teacherId]),

            // 3. Recent Arcade Scores (Live Feed)
            db.query(`
                SELECT ss.*, u.first_name, u.last_name, a.assessment_name
                FROM student_scores ss 
                JOIN users u ON ss.student_id = u.user_id
                JOIN assessments a ON ss.assessment_id = a.assessment_id
                JOIN topics t ON a.topic_id = t.topic_id 
                JOIN quarters q ON t.quarter_id = q.quarter_id
                JOIN classes c ON q.subject_id = c.subject_id
                WHERE c.teacher_id = ? 
                ORDER BY ss.date_recorded DESC LIMIT 6`, [teacherId]),

            // 4. Forum Activity (replies count)
            db.query(`
                SELECT ft.topic_id, ft.title, COUNT(fr.reply_id) as reply_count 
                FROM forum_topics ft 
                LEFT JOIN forum_replies fr ON ft.topic_id = fr.topic_id
                WHERE ft.teacher_id = ? 
                GROUP BY ft.topic_id 
                ORDER BY ft.created_at DESC LIMIT 5`, [teacherId]),

            // 5. Pending Assessments (Unlocked & Not Expired)
            db.query(`
                SELECT a.*, t.topic_name FROM assessments a 
                JOIN topics t ON a.topic_id = t.topic_id 
                JOIN quarters q ON t.quarter_id = q.quarter_id
                JOIN classes c ON q.subject_id = c.subject_id
                WHERE c.teacher_id = ? AND a.is_unlocked = 1 AND a.due_date > NOW()
                ORDER BY a.due_date ASC LIMIT 4`, [teacherId]),

            // 6. Needs Attention (Progress < 50%)
            // 6. Needs Attention (FIXED QUERY)
            db.query(`
                SELECT u.first_name, u.last_name, sp.progress_percent, s.subject_name, s.subject_id
                FROM student_progress sp 
                JOIN users u ON sp.student_id = u.user_id
                JOIN subjects s ON sp.subject_id = s.subject_id
                JOIN classes c ON s.subject_id = c.subject_id
                WHERE c.teacher_id = ? AND sp.progress_percent < 50 
                GROUP BY u.user_id, s.subject_id
                ORDER BY sp.progress_percent ASC`, [teacherId]),

            // 7. Teacher's Announcements
            db.query(`
                SELECT ann.*, c.class_name, t.topic_name 
                FROM announcements ann 
                LEFT JOIN classes c ON ann.class_id = c.class_id
                LEFT JOIN topics t ON ann.topic_id = t.topic_id
                WHERE ann.teacher_id = ? 
                ORDER BY ann.created_at DESC LIMIT 3`, [teacherId]),

            // 8. Pinned Discussions
            db.query(`SELECT * FROM forum_topics WHERE teacher_id = ? AND is_pinned = 1`, [teacherId]),

            // Halimbawa kung subject_id ang tawag sa column:
            db.query(`
                SELECT ev.* FROM calendar_events ev
                JOIN classes c ON ev.subject_id = c.subject_id
                WHERE c.teacher_id = ? 
                ORDER BY ev.event_date ASC LIMIT 5`, [teacherId])
        ]);

        // I-render ang view at ipasa ang lahat ng kailangang variables
        res.render('teacher/dashboard', {
            user: req.user,
            classes: classes,
            stats: statsResult[0] || { totalStudents: 0, totalForums: 0, totalAttempts: 0 },
            recentScores: recentScores,
            forumActivity: forumActivity, // Sinisiguro nitong hindi na mag-eerror ang Line 116
            pendingAssessments: pendingAssessments,
            needsAttention: needsAttention,
            announcements: announcements,
            pinnedDiscussions: pinnedDiscussions,
            events: events
        });

    } catch (err) {
        console.error("❌ Teacher Dashboard Error:", err);
        res.status(500).send("Nagkaroon ng problema sa pagkarga ng Dashboard.");
    }
});

module.exports = router;