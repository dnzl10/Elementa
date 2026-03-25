const express = require('express');
const router = express.Router();
const db = require('../db'); 
const { forumUpload } = require('../app'); // <-- import Multer instance

router.get('/dashboard', async (req, res) => {

    if (!req.isAuthenticated()) {
        return res.redirect('/login');
    }

    const studentId = req.user.user_id;

    try {

        const [
            [announcements],
            [upcomingTasks],
            [timeline],
            [subjects],
            [events],
            [assessmentDates],
            [recentForums]
        ] = await Promise.all([

            db.query(`
                SELECT a.*, u.first_name, u.last_name
                FROM announcements a
                JOIN users u ON a.teacher_id = u.user_id
                LEFT JOIN topics t ON a.topic_id = t.topic_id
                LEFT JOIN classes c ON a.class_id = c.class_id
                WHERE (a.topic_id IS NULL AND c.class_id IN (
                            SELECT class_id FROM class_students WHERE student_id = ?
                    ))
                OR (a.topic_id IS NOT NULL AND a.topic_id IN (
                            SELECT t.topic_id
                            FROM topics t
                            JOIN quarters q ON t.quarter_id = q.quarter_id
                            JOIN classes c ON q.subject_id = c.subject_id
                            JOIN class_students cs ON cs.class_id = c.class_id
                            WHERE cs.student_id = ?
                    ))
                ORDER BY a.created_at DESC
                LIMIT 3
            `, [studentId, studentId]),

            db.query(`
                SELECT * FROM assessments 
                WHERE due_date >= NOW() 
                AND is_unlocked = 1 
                ORDER BY due_date ASC 
                LIMIT 4
            `),

            db.query(`
                SELECT a.*, s.subject_name 
                FROM assessments a
                JOIN quarters q ON a.quarter_id = q.quarter_id
                JOIN subjects s ON q.subject_id = s.subject_id
                ORDER BY a.due_date DESC
            `),

            db.query(`
                SELECT 
                s.subject_id,
                s.subject_name,
                s.subject_code,
                COALESCE(sp.progress_percent,0) AS progress_percent,
                sp.last_accessed
                FROM class_students cs
                JOIN classes c ON cs.class_id = c.class_id
                JOIN subjects s ON c.subject_id = s.subject_id
                LEFT JOIN student_progress sp 
                       ON sp.subject_id = s.subject_id 
                       AND sp.student_id = cs.student_id
                WHERE cs.student_id = ?
                ORDER BY sp.last_accessed DESC
                LIMIT 2
            `, [studentId]),

            db.query(`
                SELECT * 
                FROM calendar_events 
                WHERE MONTH(event_date) = MONTH(CURRENT_DATE())
            `),

            db.query(`
                SELECT 
                DATE(due_date) AS due_date,
                assessment_name
                FROM assessments
                WHERE due_date IS NOT NULL
                AND is_unlocked = 1
            `),

            db.query(`
                SELECT 
                    ft.forum_id, ft.title, ft.subject_id, ft.teacher_id, ft.created_at, 
                    s.subject_code
                FROM forum_topics ft
                JOIN subjects s ON ft.subject_id = s.subject_id
                JOIN classes c ON s.subject_id = c.subject_id
                JOIN class_students cs ON c.class_id = cs.class_id
                WHERE cs.student_id = ?
                LIMIT 20 OFFSET 0
            `, [studentId]),
        ]);

        // Normalize progress
        subjects.forEach(c => {
            c.progress_percent = Math.min(100, Math.max(0, Math.round(c.progress_percent || 0)));
        });

        // Convert assessment due dates to day numbers
        const dueDays = (assessmentDates || []).map(a => {
            const d = new Date(a.due_date);
            return d.getDate();
        });


        // Calendar Logic
        const today = new Date();
        const year = today.getFullYear();
        const month = today.getMonth();

        const firstDay = new Date(year, month, 1).getDay();
        const daysInMonth = new Date(year, month + 1, 0).getDate();

        let calendarDays = [];

        for (let i = 0; i < firstDay; i++) {
            calendarDays.push(null);
        }

        for (let d = 1; d <= daysInMonth; d++) {
            calendarDays.push(d);
        }

        // Render dashboard
        res.render('dashboard-student', {
            user: req.user,
            announcements: announcements ?? [],
            upcomingTasks: upcomingTasks ?? [],
            timeline: timeline ?? [],
            subjects: subjects ?? [],
            events: events ?? [],
            calendarDays,
            month,
            year,
            dueDays,   // IMPORTANT 
            recentForums 
        });

    } catch (err) {
        // 1️⃣ Log the full error object
        console.error("Dashboard Data Error:", err);

        // 2️⃣ Log the SQL message if available (mysql2/promise)
        if (err.sqlMessage) {
            console.error("SQL Message:", err.sqlMessage);
        }
        if (err.sql) {
            console.error("SQL Query that caused error:", err.sql);
        }

        // 3️⃣ Optional: log stack trace
        console.error(err.stack);

        // 4️⃣ Respond with more info temporarily (for dev)
        if (!res.headersSent) {
            res.status(500).send("Internal Server Error: " + err.message);
        }
    }
});

// Route para sa View Profile
router.get('/profile', async (req, res) => {
    // 1. Siguraduhin na ang user ay logged in (Passport.js usually uses req.user)
    if (!req.isAuthenticated()) {
        return res.redirect('/login');
    }

    try {
        const user = req.user; // Dito galing ang data (first_name, qr_code_token, etc.)

        // 2. Generate ang QR Code Base64 string gamit ang token ng user
        // Kung walang token, maaari mong gamitin ang email o ID bilang fallback
        const token = user.qr_code_token || `USER-${user.id}`;
        const qrCodeData = await QRCode.toDataURL(token, {
            color: {
                dark: '#1e293b', // Kulay ng QR (Slate 800)
                light: '#ffffff' // Background
            },
            margin: 2
        });

        // 3. I-render ang profile page at ipasa ang user at qrCodeData
        res.render('profile', { 
            user: user, 
            qrCodeData: qrCodeData 
        });

    } catch (err) {
        console.error("Profile Rendering Error:", err);
        res.status(500).send("Internal Server Error");
    }
});

router.post('/update-profile', async (req, res) => {
    if (!req.isAuthenticated()) return res.status(401).send("Unauthorized");

    const { city_town, mobile, address, pic_description } = req.body;
    const userId = req.user.user_id;

    try {
        await db.query(
            `UPDATE users SET city_town = ?, mobile = ?, address = ?, pic_description = ? WHERE user_id = ?`,
            [city_town, mobile, address, pic_description, userId]
        );
        
        res.redirect('/profile'); // Balik sa profile after save
    } catch (err) {
        console.error(err);
        res.status(500).send("Failed to update profile");
    }
});

const QRCode = require('qrcode'); // Siguraduhing naka-import ito sa taas

// GET /home - Listahan ng mga subjects na pwedeng pasukan
router.get('/home', async (req, res) => {
    if (!req.isAuthenticated()) return res.status(401).send("Unauthorized");

    const studentId = req.user.user_id;

    try {
        // Kunin ang subjects na HINDI pa naka-enroll ang student (base sa student_progress)
        const [subjects] = await db.query(`
            SELECT s.*, u.first_name, u.last_name, u.profile_pic
            FROM subjects s
            LEFT JOIN classes c ON s.subject_id = c.subject_id
            LEFT JOIN users u ON c.teacher_id = u.user_id
            WHERE s.subject_id NOT IN (
                SELECT subject_id FROM student_progress WHERE student_id = ?
            )
        `, [studentId]);

        res.render('home-student', { user: req.user, subjects });
    } catch (err) {
        console.error(err);
        res.status(500).send("Server Error");
    }
});

// POST /enroll - Logic para sa pag-enroll gamit ang code
router.post('/enroll', async (req, res) => {
    
    const { subject_id, enrollment_code } = req.body;
    const student_id = req.user.user_id; // Passport.js gamit mo kaya req.user dapat

    try {
        // 1. I-verify ang Code at kunin ang Class ID
        // Ginagamit natin ang JOIN para makuha ang class_id na naka-link sa subject na iyon
        const [subjectData] = await db.query(`
            SELECT s.enrollment_code, c.class_id 
            FROM subjects s
            JOIN classes c ON s.subject_id = c.subject_id
            WHERE s.subject_id = ?
        `, [subject_id]);

        if (subjectData.length === 0 || subjectData[0].enrollment_code !== enrollment_code) {
            return res.send("<script>alert('Maling Enrollment Code!'); window.location='/home';</script>");
        }

        const class_id = subjectData[0].class_id;

        // 2. I-check kung enrolled na (safety check)
        const [existing] = await db.query(
            "SELECT * FROM student_progress WHERE student_id = ? AND subject_id = ?",
            [student_id, subject_id]
        );

        if (existing.length > 0) {
            return res.send("<script>alert('Enrolled ka na rito!'); window.location='/dashboard';</script>");
        }

        // 3. TRANSACTION: Mag-insert sa dalawang table nang sabay
        // Para siguradong lalabas sa Dashboard (class_students) at may progress tracking (student_progress)
        await db.query("INSERT INTO student_progress (student_id, subject_id, progress_percent) VALUES (?, ?, 0)", [student_id, subject_id]);
        await db.query("INSERT INTO class_students (class_id, student_id) VALUES (?, ?)", [class_id, student_id]);

        res.send("<script>alert('Enrollment Successful!'); window.location='/dashboard';</script>");
    } catch (err) {
        console.error(err);
        res.status(500).send("Enrollment Failed");
    }
});

// GET Events Page
router.get('/events', async (req, res) => {
    // 1. Check if authenticated
    if (!req.isAuthenticated()) {
        return res.redirect('/login');
    }

    try {
        // 2. Consistent variable naming (studentId)
        const studentId = req.user.user_id;

        // 3. Get events for enrolled subjects
        const [events] = await db.query(`
            SELECT e.*, s.subject_name, s.subject_code 
            FROM calendar_events e
            JOIN subjects s ON e.subject_id = s.subject_id
            JOIN classes c ON s.subject_id = c.subject_id
            JOIN class_students cs ON c.class_id = cs.class_id
            WHERE cs.student_id = ?
            ORDER BY e.event_date ASC
        `, [studentId]);

        // 4. Get enrolled subjects for the dropdown
        const [userSubjects] = await db.query(`
            SELECT s.subject_id, s.subject_name 
            FROM subjects s
            JOIN classes c ON s.subject_id = c.subject_id
            JOIN class_students cs ON c.class_id = cs.class_id
            WHERE cs.student_id = ?
        `, [studentId]);

        // 5. Use req.user instead of req.session.user
        res.render('event-student', { 
            user: req.user, 
            events: events || [], 
            userSubjects: userSubjects || [] 
        });

    } catch (error) {
        console.error("Events Route Error:", error);
        res.status(500).send("Internal Server Error");
    }
});

// POST Add New Event
router.post('/events/add', async (req, res) => {
    try {
        const { 
            subject_id, event_title, event_description, event_type, 
            event_date, event_location, duration_type, 
            start_date, end_date, duration_minutes, 
            is_repeatable, repeat_cycle 
        } = req.body;

        // I-handle ang mga nullable fields base sa duration_type
        const finalStartDate = duration_type === 'DateRange' ? start_date : null;
        const finalEndDate = duration_type === 'DateRange' ? end_date : null;
        const finalMinutes = duration_type === 'Minutes' ? duration_minutes : null;
        
        // I-handle ang repeatability logic
        const repeatableStatus = is_repeatable === 'on' ? 1 : 0;
        const finalRepeatCycle = repeatableStatus === 1 ? repeat_cycle : 'None';

        const query = `
            INSERT INTO calendar_events (
                subject_id, event_title, event_description, event_location, 
                event_type, event_date, duration_type, 
                start_date, end_date, duration_minutes, 
                is_repeatable, repeat_cycle
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `;

        await db.query(query, [
            subject_id, event_title, event_description, event_location,
            event_type, event_date, duration_type,
            finalStartDate, finalEndDate, finalMinutes,
            repeatableStatus, finalRepeatCycle
        ]);

        res.redirect('/events?success=Event+Added');
    } catch (error) {
        console.error(error);
        res.status(500).send("Error saving event");
    }
});

router.get('/subjects', async (req, res) => {
    try {
        // Kunin ang student ID mula sa session (kung Passport.js ito, karaniwang req.user.user_id)
        const studentId = req.user ? req.user.user_id : req.session.userId;

        if (!studentId) {
            return res.redirect('/login');
        }

        // Query base sa iyong SQL structure:
        // Users -> class_students -> classes -> subjects
        // classes -> users (para sa Teacher name)
        // classes -> school_years (para sa SY range)
        const [enrolledSubjects] = await db.execute(`
            SELECT 
                s.subject_id,
                s.subject_code,
                s.subject_name,
                s.subject_image,
                s.description,
                s.semester,
                CONCAT(t.first_name, ' ', t.last_name) AS teacher_name,
                sy.sy_range
            FROM class_students cs
            JOIN classes c ON cs.class_id = c.class_id
            JOIN subjects s ON c.subject_id = s.subject_id
            JOIN users t ON c.teacher_id = t.user_id
            JOIN school_years sy ON c.sy_id = sy.sy_id
            WHERE cs.student_id = ?
        `, [studentId]);

        // I-render ang EJS at ipasa ang data
        res.render('subject-student', {
            user: req.user, // Siguraduhin na may user object para sa header profile
            subjects: enrolledSubjects
        });

    } catch (error) {
        console.error("Database Error sa Subjects Page:", error);
        res.status(500).send("Nagkaroon ng problema sa pag-load ng iyong mga subjects.");
    }
});

// GET /subjects/open/:id - View specific subject details
router.get('/subjects/open/:id', async (req, res) => {
    if (!req.isAuthenticated()) return res.redirect('/login');

    const subjectId = req.params.id;
    const studentId = req.user.user_id;

    try {
        // 1. SUBJECT INFO
        const [subjectInfo] = await db.query(`
            SELECT s.*, c.class_name, sy.sy_range, CONCAT(u.first_name, ' ', u.last_name) AS teacher_name, u.profile_pic AS teacher_pic
            FROM subjects s
            JOIN classes c ON s.subject_id = c.subject_id
            JOIN school_years sy ON c.sy_id = sy.sy_id
            JOIN users u ON c.teacher_id = u.user_id
            WHERE s.subject_id = ?
        `, [subjectId]);

        if (subjectInfo.length === 0) return res.status(404).send("Subject not found");

        // 2. GET QUARTERS
        const [quartersRaw] = await db.query(`SELECT * FROM quarters WHERE subject_id = ?`, [subjectId]);

        // 3. GET TOPICS
        const [topicsRaw] = await db.query(`
            SELECT * FROM topics WHERE quarter_id IN (
                SELECT quarter_id FROM quarters WHERE subject_id = ?
            )
        `, [subjectId]);

        // 4. GET MATERIALS
        const [materialsRaw] = await db.query(`
            SELECT * FROM learning_materials WHERE topic_id IN (
                SELECT topic_id FROM topics WHERE quarter_id IN (
                    SELECT quarter_id FROM quarters WHERE subject_id = ?
                )
            )
        `, [subjectId]);

        // 5. GET ASSESSMENTS
        const [assessmentsRaw] = await db.query(`
            SELECT a.*
            FROM assessments a
            JOIN topics t ON a.topic_id = t.topic_id
            JOIN quarters q ON t.quarter_id = q.quarter_id
            WHERE q.subject_id = ?
            ORDER BY a.due_date ASC
        `, [subjectId]);

        // 6. GET ANNOUNCEMENTS
        const [announcementsRaw] = await db.query(`
            SELECT a.*, u.first_name, u.last_name
            FROM announcements a
            JOIN users u ON a.teacher_id = u.user_id
            LEFT JOIN topics t ON a.topic_id = t.topic_id
            LEFT JOIN classes c ON a.class_id = c.class_id
            WHERE (a.topic_id IS NULL AND c.class_id IN (
                        SELECT class_id FROM class_students WHERE student_id = ?
                ))
            OR (a.topic_id IS NOT NULL AND a.topic_id IN (
                        SELECT t.topic_id
                        FROM topics t
                        JOIN quarters q ON t.quarter_id = q.quarter_id
                        JOIN classes c ON q.subject_id = c.subject_id
                        JOIN class_students cs ON cs.class_id = c.class_id
                        WHERE cs.student_id = ?
                ))
            ORDER BY a.created_at DESC
            LIMIT 3
        `, [studentId, studentId]);

        // 7. GET FORUM THREADS
        const [forumsRaw] = await db.query(`
            SELECT f.*, CONCAT(u.first_name, ' ', u.last_name) AS author_name
            FROM forum_topics f
            JOIN users u ON f.teacher_id = u.user_id
            WHERE f.subject_id = ?
            ORDER BY f.created_at DESC
            LIMIT 5
        `, [subjectId]);

        // 8. STUDENT COMPLETED TASKS
        const [doneForums] = await db.query(`SELECT forum_id FROM student_forum_done WHERE student_id = ?`, [studentId]);
        const [doneAssessments] = await db.query(`SELECT DISTINCT assessment_id FROM student_scores WHERE student_id = ?`, [studentId]);

        // 9. BUILD NESTED QUARTERS/TOPICS
        const quarters = quartersRaw.map((q, qIndex) => {
            const topics = topicsRaw
                .filter(t => t.quarter_id === q.quarter_id)
                .map((t, tIndex) => {
                    const topicLocked = t.is_locked === 1 || tIndex !== 0;

                    const materials = materialsRaw.filter(m => m.topic_id === t.topic_id);

                    const assessments = assessmentsRaw
                        .filter(a => a.topic_id === t.topic_id)
                        .map((a, aIndex) => ({
                            ...a,
                            is_unlocked: topicLocked ? 0 : (aIndex === 0 ? 1 : 0),
                            is_done: doneAssessments.some(da => da.assessment_id === a.assessment_id) ? 1 : 0
                        }));

                    const topicForums = forumsRaw
                        .filter(f => f.topic_id === t.topic_id)
                        .map(f => ({
                            ...f,
                            is_unlocked: topicLocked ? 0 : 1,
                            is_done: doneForums.some(df => df.forum_id === f.forum_id) ? 1 : 0
                        }));

                    const topicAnnouncements = announcementsRaw.filter(a => a.topic_id === t.topic_id);

                    return {
                        ...t,
                        is_locked: topicLocked,
                        materials,
                        assessments,
                        forums: topicForums,
                        announcements: topicAnnouncements
                    };
                });

            return { ...q, topics };
        });

        // 10. CALCULATE PROGRESS PERCENT
        let totalTasks = 0, completedTasks = 0;
        quarters.forEach(q => {
            q.topics.forEach(t => {
                if (t.is_locked) return; // skip locked topics
                t.forums.forEach(f => { totalTasks++; if (f.is_done) completedTasks++; });
                t.assessments.forEach(a => { totalTasks++; if (a.is_done) completedTasks++; });
            });
        });

        const progressPercent = totalTasks === 0 ? 0 : Math.round((completedTasks / totalTasks) * 100);

        // 11. UPDATE student_progress
        await db.query(`
            INSERT INTO student_progress (student_id, subject_id, progress_percent)
            VALUES (?, ?, ?)
            ON DUPLICATE KEY UPDATE progress_percent = VALUES(progress_percent)
        `, [studentId, subjectId, progressPercent]);

        // 12. GET LEADERBOARD
        const [leaderboard] = await db.query(`
            SELECT u.first_name, u.last_name, COALESCE(sp.progress_percent, 0) as total_exp
            FROM student_progress sp
            JOIN users u ON sp.student_id = u.user_id
            WHERE sp.subject_id = ?
            ORDER BY sp.progress_percent DESC
            LIMIT 5
        `, [subjectId]);

        // 13. RENDER
        res.render('opensubject-student', {
            user: req.user,
            subject: subjectInfo[0],
            quarters,
            progress: progressPercent,
            leaderboard: leaderboard || []
        });

    } catch (error) {
        console.error("FULL ERROR DETAILS:", error);
        res.status(500).send("Nagkaroon ng problema sa pag-load ng data: " + error.message);
    }
});

// GET /leaderboards - View global and subject-specific leaderboards
router.get('/leaderboards', async (req, res) => {
    if (!req.isAuthenticated()) return res.redirect('/login');
    const studentId = req.user.user_id;

    try {
        // 1. GLOBAL RANKINGS (Top Alchemists)
        const [globalTop] = await db.query(`
            SELECT first_name, last_name, profile_pic, total_exp, current_level, strand, section 
            FROM users WHERE role = 'Student' 
            ORDER BY total_exp DESC LIMIT 10
        `);

        // 2. SUBJECT-SPECIFIC (Sample: Top students in all subjects they are enrolled in)
        const [subjectRankings] = await db.query(`
            SELECT subject_name, first_name, last_name, progress_percent
            FROM (
                SELECT 
                    s.subject_name, 
                    u.first_name, 
                    u.last_name, 
                    sp.progress_percent,
                    -- Binibigyan nito ng rank (#1, #2, #3...) ang bawat student SA LOOB ng bawat subject
                    ROW_NUMBER() OVER (PARTITION BY s.subject_id ORDER BY sp.progress_percent DESC) as student_rank
                FROM student_progress sp
                JOIN subjects s ON sp.subject_id = s.subject_id
                JOIN users u ON sp.student_id = u.user_id
            ) AS ranked_progress
            WHERE student_rank <= 3 -- Dito natin lilimitahan: Top 3 lang kada subject ang lalabas
            ORDER BY subject_name, progress_percent DESC;
        `);

        // 3. PVP KINGS (Most Wins in Arcade)
        const [pvpKings] = await db.query(`
            SELECT u.first_name, u.last_name, u.profile_pic, COUNT(m.winner_id) as wins
            FROM competitive_matches m
            JOIN users u ON m.winner_id = u.user_id
            GROUP BY m.winner_id
            ORDER BY wins DESC LIMIT 5
        `);

        // 4. PERSONAL RANK CARD (Logic to find current user's rank)
        const [personalRank] = await db.query(`
            SELECT rank FROM (
                SELECT user_id, RANK() OVER (ORDER BY total_exp DESC) as rank 
                FROM users WHERE role = 'Student'
            ) as ranking WHERE user_id = ?
        `, [studentId]);

        const [totalStudents] = await db.query(`SELECT COUNT(*) as count FROM users WHERE role = 'Student'`);

        // 5. WALL OF FAME (History)
        const [history] = await db.query(`
            SELECT h.*, u.first_name, u.last_name, s.subject_name 
            FROM leaderboard_history h
            JOIN users u ON h.student_id = u.user_id
            LEFT JOIN subjects s ON h.subject_id = s.subject_id
            ORDER BY h.awarded_date DESC LIMIT 10
        `);

        res.render('leaderboard-student', {
            user: req.user,
            globalTop,
            subjectRankings,
            pvpKings,
            history,
            myRank: personalRank[0] ? personalRank[0].rank : 'N/A',
            totalCount: totalStudents[0].count
        });
    } catch (error) {
        console.error(error);
        res.status(500).send("Error loading leaderboards");
    }
});

// GET: Main Forum Page
router.get('/forums', async (req, res) => {
    if (!req.isAuthenticated()) return res.redirect('/login');
    const studentId = req.user.user_id;

    try {
        const [forums] = await db.query(`
            SELECT ft.*, s.subject_name, t.topic_name, 
                u.first_name as teacher_fname, u.last_name as teacher_lname, u.profile_pic as teacher_pic,
                (SELECT COUNT(*) FROM forum_replies fr WHERE fr.topic_id = ft.topic_id) as reply_count,
                (SELECT EXISTS(
                            SELECT 1 FROM student_forum_done sfd 
                            WHERE sfd.forum_id = ft.forum_id AND sfd.student_id = ?
                )) as is_done
            FROM forum_topics ft
            LEFT JOIN subjects s ON ft.subject_id = s.subject_id
            LEFT JOIN topics t ON ft.topic_id = t.topic_id
            LEFT JOIN users u ON ft.teacher_id = u.user_id
            WHERE ft.subject_id IN (
                SELECT c.subject_id 
                FROM class_students cs
                JOIN classes c ON cs.class_id = c.class_id
                WHERE cs.student_id = ?
            )
            ORDER BY ft.is_pinned DESC, ft.created_at DESC
        `, [studentId, studentId]);

        const [participation] = await db.query(`
            SELECT COUNT(*) as total 
            FROM forum_replies 
            WHERE user_id = ?`, [studentId]);

        res.render('forum-student', {
            user: req.user,
            forums,                     // ✅ pass as 'forums'
            totalParticipated: participation[0].total || 0
        });

    } catch (error) {
        console.error("FORUM ERROR:", error);
        res.status(500).send("Database Error");
    }
});

// ==============================
// 📌 GET: SINGLE FORUM (FOR MODAL)
// ==============================
router.get('/api/forum-topic/:id', async (req, res) => {
    if (!req.isAuthenticated()) {
        return res.status(401).json({ error: "Unauthorized" });
    }

    try {
        const [rows] = await db.query(`
            SELECT 
                ft.forum_id,
                ft.forum_content,
                ft.created_at,
                CONCAT(u.first_name, ' ', u.last_name) AS teacher_name
            FROM forum_topics ft
            JOIN users u ON ft.teacher_id = u.user_id
            WHERE ft.forum_id = ?
        `, [req.params.id]);

        if (rows.length === 0) {
            return res.status(404).json({ error: "Not found" });
        }

        res.json(rows[0]);

    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});

// ==============================
// 📌 GET: REPLIES
// ==============================
router.get('/api/forum-replies/:forumId', async (req, res) => {
    if (!req.isAuthenticated()) {
        return res.status(401).json({ error: "Unauthorized" });
    }

    try {
        const [replies] = await db.query(`
            SELECT fr.*, 
                   u.first_name, 
                   u.last_name, 
                   u.profile_pic
            FROM forum_replies fr
            JOIN users u ON fr.user_id = u.user_id
            WHERE fr.topic_id = ?
            ORDER BY fr.created_at ASC
        `, [req.params.forumId]);

        res.json(replies);

    } catch (error) {
        console.error(error);
        res.status(500).json({ error: error.message });
    }
});

// ==============================
// 📌 POST: REPLY WITH FILE
// ==============================
router.post('/api/forum-reply', (req, res) => {
    forumUpload(req, res, async (err) => {
        if (err) {
            console.error('Multer upload error:', err);
            return res.status(400).json({ success: false, error: "Upload error: " + err.message });
        }

        console.log('--- DEBUG Multer Output ---');
        console.log('req.body:', req.body);
        console.log('req.file:', req.file);

        if (!req.user) {
            return res.status(401).json({ success: false, error: "Session expired. Please login again." });
        }

        const userId = req.user.user_id;
        const { forum_id, reply_text, parent_id } = req.body;
        const replyText = (reply_text || '').trim();
        if (!forum_id || !replyText) {
            return res.status(400).json({ success: false, error: "Reply content and Forum ID are required." });
        }

        const safeParentId = parent_id && !isNaN(parent_id) ? parseInt(parent_id) : null;

        // File info (safe)
        const filePath = req.file ? req.file.filename : null;
        const fileName = req.file ? req.file.originalname : null;
        const fileType = req.file ? req.file.mimetype : null;

        try {
            const sql = `
                INSERT INTO forum_replies 
                (topic_id, user_id, parent_reply_id, reply_content, file_path, file_name, file_type, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, NOW())
            `;

            const [result] = await db.query(sql, [
                forum_id,
                userId,
                safeParentId,
                replyText,
                filePath,
                fileName,
                fileType
            ]);

            console.log('Reply saved successfully. ID:', result.insertId);

            return res.status(200).json({
                success: true,
                message: "Reply posted successfully!",
                reply_id: result.insertId
            });

        } catch (sqlErr) {
            console.error('DATABASE ERROR:', sqlErr);
            return res.status(500).json({ success: false, error: sqlErr.sqlMessage || sqlErr.message });
        }
    });
});

// ==============================
// 📌 OPTIONAL: THREAD PAGE
// ==============================
router.get('/forum-thread/:forumId', async (req, res) => {
    if (!req.isAuthenticated()) return res.redirect('/login');

    try {
        const [forum] = await db.query(`
            SELECT ft.*, u.first_name, u.last_name
            FROM forum_topics ft
            JOIN users u ON ft.teacher_id = u.user_id
            WHERE ft.forum_id = ?
        `, [req.params.forumId]);

        if (!forum.length) {
            return res.status(404).send("Forum not found");
        }

        res.render('forum-thread', {
            user: req.user,
            forum: forum[0]
        });

    } catch (err) {
        console.error(err);
        res.status(500).send("Error loading thread");
    }
});

// GET: Unified Notifications for the Slide-over
router.get('/api/notifications', async (req, res) => {
    if (!req.isAuthenticated()) return res.status(401).json([]);
    const studentId = req.user.user_id;

    try {
        const query = `
            -- 1. NEW ANNOUNCEMENTS
            (SELECT 
                'announcement' AS type, 
                a.title AS heading, 
                a.content AS snippet, 
                a.created_at, 
                NULL AS extra_info 
            FROM announcements a
            WHERE a.class_id IN (SELECT class_id FROM class_students WHERE student_id = ?))

            UNION ALL

            -- 2. UPCOMING ASSESSMENTS (Deadlines)
            (SELECT 
                'assessment' AS type, 
                ass.assessment_name AS heading, 
                CONCAT('Due Date: ', DATE_FORMAT(ass.due_date, '%M %d, %h:%i %p')) AS snippet, 
                ass.due_date AS created_at, 
                ass.assessment_type AS extra_info
            FROM assessments ass
            JOIN topics t ON ass.topic_id = t.topic_id
            JOIN quarters q ON t.quarter_id = q.quarter_id
            WHERE q.subject_id IN (
                SELECT c.subject_id FROM class_students cs
                JOIN classes c ON cs.class_id = c.class_id
                WHERE cs.student_id = ?
            )
            AND ass.due_date > NOW())

            UNION ALL

            -- 3. NEW LEARNING MATERIALS
            (SELECT 
                'material' AS type, 
                lm.title AS heading, 
                CONCAT('New ', lm.material_type, ' uploaded') AS snippet, 
                NOW() AS created_at, 
                s.subject_name AS extra_info
            FROM learning_materials lm
            JOIN topics t ON lm.topic_id = t.topic_id
            JOIN quarters q ON t.quarter_id = q.quarter_id
            JOIN subjects s ON q.subject_id = s.subject_id
            WHERE s.subject_id IN (
                SELECT c.subject_id FROM class_students cs
                JOIN classes c ON cs.class_id = c.class_id
                WHERE cs.student_id = ?
            ))

            UNION ALL

            -- 4. NEW FORUM TOPICS
            (SELECT 
                'forum_new' AS type, 
                ft.title AS heading, 
                'New discussion started' AS snippet, 
                ft.created_at, 
                s.subject_name AS extra_info
            FROM forum_topics ft
            JOIN subjects s ON ft.subject_id = s.subject_id
            WHERE s.subject_id IN (
                SELECT c.subject_id FROM class_students cs
                JOIN classes c ON cs.class_id = c.class_id
                WHERE cs.student_id = ?
            ))

            UNION ALL

            -- 5. REPLIES ON FORUMS YOU PARTICIPATED IN
            (SELECT 
                'forum_reply' AS type, 
                'New Reply in Thread' AS heading, 
                fr.reply_content AS snippet, 
                fr.created_at, 
                u.first_name AS extra_info
            FROM forum_replies fr
            JOIN users u ON fr.user_id = u.user_id
            WHERE fr.topic_id IN (SELECT topic_id FROM forum_replies WHERE user_id = ?)
            AND fr.user_id != ?)

            UNION ALL

            -- 6. RECENT SCORES & EXP GAINED
            (SELECT 
                'score' AS type, 
                ass.assessment_name AS heading, 
                CONCAT('Score: ', ss.score_obtained, '/', ss.total_items) AS snippet, 
                ss.date_recorded AS created_at, 
                CONCAT('+', ss.exp_gained, ' EXP') AS extra_info
            FROM student_scores ss
            JOIN assessments ass ON ss.assessment_id = ass.assessment_id
            WHERE ss.student_id = ?)

            ORDER BY created_at DESC 
            LIMIT 20;
        `;

        // We have 7 placeholders (?) in the query above.
        const [notifications] = await db.query(query, [
            studentId, // 1. Announcements
            studentId, // 2. Assessments
            studentId, // 3. Materials
            studentId, // 4. Forums
            studentId, // 5. Forum Replies (thread check)
            studentId, // 5. Forum Replies (exclude self)
            studentId  // 6. Scores
        ]);

        res.json(notifications);
    } catch (err) {
        console.error("NOTIFICATION API ERROR:", err);
        res.status(500).json({ error: "Internal Server Error" });
    }
});

// routes/student.js

// DAPAT NANDITO ITO:
router.get('/arcade/standby', (req, res) => {
    res.render('arcade/standby'); // Siguraduhing may views/arcade/standby.ejs ka
});

// Verification Logic
router.get('/arcade/verify', async (req, res) => {
    const { token } = req.query;

    try {
        // Gagamit tayo ng LEFT JOIN para hindi tayo ma-block kung walang assessment
        const query = `
            SELECT u.*, a.assessment_name, a.assessment_type 
            FROM users u
            LEFT JOIN assessments a ON u.flagged_assessment_id = a.assessment_id
            WHERE u.qr_code_token = ?
        `;
        const [results] = await db.execute(query, [token]);

        if (results.length > 0) {
            const user = results[0];
            
            // Fallback: Kung walang nahanap na assessment name, bigyan ng default
            const assessmentData = {
                assessment_name: user.assessment_name || "No Assessment Selected",
                assessment_type: user.assessment_type || "N/A"
            };

            res.render('arcade/welcome', { 
                user: user, 
                assessment: assessmentData 
            });
        } else {
            res.redirect('/arcade/standby?error=not_found');
        }
    } catch (err) {
        console.error("SQL Error:", err);
        res.redirect('/arcade/standby');
    }
});

// --- ARCADE GUIDELINES ---
router.get('/arcade/guidelines/:token', async (req, res) => {
    const token = req.params.token;

    try {
        const query = `
            SELECT u.*, a.assessment_name, a.assessment_type, a.total_items 
            FROM users u
            JOIN assessments a ON u.flagged_assessment_id = a.assessment_id
            WHERE u.qr_code_token = ?
        `;
        const [results] = await db.execute(query, [token]);

        if (results.length > 0) {
            const data = results[0];
            const total = data.total_items || 15; // Fallback to 15 if null

            // Dynamic Distribution Logic
            const base = Math.floor(total / 3);
            const remainder = total % 3;

            const distribution = {
                easy: base + remainder, // Ang butal ay laging napupunta sa Easy
                average: base,
                difficult: base
            };

            res.render('arcade/guidelines', { 
                user: data, 
                assessment: data,
                total: total,
                dist: distribution
            });
        } else {
            res.redirect('/arcade/standby');
        }
    } catch (err) {
        console.error("Guidelines Error:", err);
        res.redirect('/arcade/standby');
    }
});

router.get('/arcade/game/:token', async (req, res) => {
    const token = req.params.token;

    try {
        // 1. Kunin ang user at ang details ng assessment na naka-flag sa kanya
        const [userResults] = await db.execute(`
            SELECT u.user_id, u.flagged_assessment_id, a.assessment_type, a.topic_id, a.quarter_id 
            FROM users u
            LEFT JOIN assessments a ON u.flagged_assessment_id = a.assessment_id
            WHERE u.qr_code_token = ?`, 
            [token]
        );
        
        if (userResults.length === 0) {
            console.log("❌ Error: Token not found.");
            return res.redirect('/arcade/standby');
        }

        const user = userResults[0];

        if (!user.flagged_assessment_id) {
            console.log(`❌ Error: User ${user.user_id} has no flagged assessment.`);
            return res.redirect('/arcade/standby');
        }

        const assessmentId = user.flagged_assessment_id;
        const type = user.assessment_type;

        // 2. DYNAMIC SCOPE LOGIC
        // Kung Quiz -> Topic ID lang. Kung Pre/Post/Competitive -> Buong Quarter.
        let questionFilter = "";
        let queryParams = [];

        if (type === 'Quiz' && user.topic_id) {
            questionFilter = `q.topic_id = ?`;
            // Tatlong beses dahil sa UNION (Easy, Average, Difficult)
            queryParams = [user.topic_id, user.topic_id, user.topic_id];
        } else {
            // Default to Quarter scope if Pre-test, Post-test, or Competitive
            questionFilter = `q.topic_id IN (SELECT topic_id FROM topics WHERE quarter_id = ?)`;
            queryParams = [user.quarter_id, user.quarter_id, user.quarter_id];
        }

        // 3. MASTER QUERY WITH SCOPE FILTERING
        // Kumukuha ng 5 random questions per difficulty level
        const gameQuery = `
            (SELECT q.*, GROUP_CONCAT(y.correct_symbol ORDER BY y.answer_order ASC) as answers 
             FROM question_bank q 
             LEFT JOIN youtubes y ON q.question_id = y.question_id
             WHERE q.difficulty = 'Easy' AND ${questionFilter}
             GROUP BY q.question_id ORDER BY RAND() LIMIT 5)
            UNION ALL
            (SELECT q.*, GROUP_CONCAT(y.correct_symbol ORDER BY y.answer_order ASC) as answers 
             FROM question_bank q 
             LEFT JOIN youtubes y ON q.question_id = y.question_id
             WHERE q.difficulty = 'Average' AND ${questionFilter}
             GROUP BY q.question_id ORDER BY RAND() LIMIT 5)
            UNION ALL
            (SELECT q.*, GROUP_CONCAT(y.correct_symbol ORDER BY y.answer_order ASC) as answers 
             FROM question_bank q 
             LEFT JOIN youtubes y ON q.question_id = y.question_id
             WHERE q.difficulty = 'Difficult' AND ${questionFilter}
             GROUP BY q.question_id ORDER BY RAND() LIMIT 5)
        `;

        const [questions] = await db.execute(gameQuery, queryParams);

        if (questions.length === 0) {
            console.log("❌ Error: No questions found for this scope.");
            return res.redirect('/arcade/standby');
        }

        // Shuffle all questions to mix difficulties if preferred
        const shuffledQuestions = questions.sort(() => Math.random() - 0.5);

        console.log(`✅ Mission Started: ${user.first_name} | Type: ${type} | Items: ${questions.length}`);

        res.render('arcade/game', { 
            questions: shuffledQuestions, 
            user: user,
            token: token,
            assessmentId: assessmentId
        });

    } catch (err) {
        console.error("🔥 CRITICAL GAME ROUTE ERROR:", err.message);
        res.redirect('/arcade/standby');
    }
});

router.post('/arcade/submit-results', async (req, res) => {
    const { userId, assessmentId, score, totalItems, expGained } = req.body;

    if (!userId || !assessmentId) {
        return res.status(400).json({ success: false, message: "Missing required data." });
    }

    const connection = await db.getConnection();

    try {
        await connection.beginTransaction();

        // 1. I-save ang performance ng student
        await connection.execute(
            `INSERT INTO student_scores (student_id, assessment_id, score_obtained, total_items, exp_gained, date_recorded) 
             VALUES (?, ?, ?, ?, ?, NOW())`,
            [userId, assessmentId, score, totalItems, expGained]
        );

        // 2. I-update ang User Stats at i-reset ang arcade flags
        await connection.execute(
            `UPDATE users 
             SET total_exp = total_exp + ?, 
                 is_ready_for_arcade = 0, 
                 flagged_assessment_id = NULL 
             WHERE user_id = ?`,
            [expGained, userId]
        );

        // 3. Surpassed Logic: Ilang UNIQUE students ang mas mababa ang score sa kanya sa assessment na ito
        const [rankData] = await connection.execute(
            `SELECT COUNT(DISTINCT student_id) as surpassedCount 
             FROM student_scores 
             WHERE assessment_id = ? AND score_obtained < ?`,
            [assessmentId, score]
        );

        await connection.commit();

        res.json({ 
            success: true, 
            message: "Mission Accomplished!",
            surpassedCount: rankData[0].surpassedCount || 0,
            finalScore: score,
            totalExpGained: expGained
        });

    } catch (err) {
        await connection.rollback();
        console.error("❌ Submission Error:", err);
        res.status(500).json({ success: false, error: "Database transaction failed." });
    } finally {
        connection.release();
    }
});

router.get('/test-game', (req, res) => {
    const mockQuestions = [
        {
            question_text: "What is the chemical symbol for Water?",
            input_mode: "Periodic",
            answers: "H,H,O",
            required_answers_count: 3,
            base_exp: 150,
            time_limit: 15
        },
        {
            question_text: "Which of these is a Noble Gas?",
            input_mode: "Standard",
            option_a: "Oxygen",
            option_b: "Neon",
            option_c: "Iron",
            option_d: "Silver",
            answers: "B",
            base_exp: 100,
            time_limit: 10
        }
    ];
    res.render('arcade/game', { questions: mockQuestions, user: { user_id: 1 } });
});


module.exports = router;