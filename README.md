# 🎓 CampusConnect — College Club & Event Management Platform

[![Release](https://img.shields.io/badge/release-v1.2.0-blue.svg)](https://github.com/MokuLakshithReddy/campus-connect/releases/tag/v1.2.0)
[![Android APK](https://img.shields.io/badge/platform-Android%20%7C%20Web-brightgreen.svg)](https://github.com/MokuLakshithReddy/campus-connect/releases/download/v1.2.0/campus-connect-v1.2.0.apk)
[![Vite](https://img.shields.io/badge/frontend-Vite%20%2B%20React%20%2B%20TS-646CFF.svg)](https://vitejs.dev/)
[![Tailwind CSS](https://img.shields.io/badge/styling-Tailwind%20CSS-38B2AC.svg)](https://tailwindcss.com/)
[![Supabase](https://img.shields.io/badge/backend-Supabase%20%28PostgreSQL%29-3ECF8E.svg)](https://supabase.com/)

**CampusConnect** is a college-focused digital workspace combining club management, community communication, and campus event discovery into a unified university platform.

Instead of generic social media feeds, CampusConnect equips every student club with a structured digital space while ensuring students never miss important workshops, hackathons, or official notices.

---

## 📱 Mobile App Download

Get the latest native Android APK directly on your phone:
- **[📥 Download CampusConnect APK (v1.2.0)](https://github.com/MokuLakshithReddy/campus-connect/releases/download/v1.2.0/campus-connect-v1.2.0.apk)** *(4.4 MB)*
- **[View All Releases](https://github.com/MokuLakshithReddy/campus-connect/releases)**

---

## At a glance

![GitHub stars](https://img.shields.io/github/stars/MokuLakshithReddy/campus-connect?style=flat-square&label=stars)
![GitHub forks](https://img.shields.io/github/forks/MokuLakshithReddy/campus-connect?style=flat-square&label=forks)
![Open issues](https://img.shields.io/github/issues/MokuLakshithReddy/campus-connect?style=flat-square&label=open%20issues)
![Last commit](https://img.shields.io/github/last-commit/MokuLakshithReddy/campus-connect?style=flat-square)

**Why it matters:** Campus information is often scattered across messages, social feeds, and separate event forms. CampusConnect gives clubs structured spaces and gives students one place to discover events, register, and present a QR pass at check-in.

## Core user journey

```mermaid
flowchart TD
    S["Verified student identity"] --> C["Discover clubs and campus events"]
    C --> M["Join a club workspace"]
    M --> CH["Announcements, discussion and project channels"]
    C --> E["Register for an event"]
    E --> Q["Generate unique QR attendance pass"]
    Q --> V["Organizer verifies attendance"]
    R["College admin / club organizer"] --> RBAC["Role-based permissions"]
    RBAC --> M
    RBAC --> E
    RBAC --> V
    RBAC --> DB[("PostgreSQL with Row Level Security")]
    M --> DB
    E --> DB
    V --> DB
```

---
## ✨ Key Capabilities

### 1. 🏛️ Club-Specific Workspaces
Every student organization has its own private community with four distinct spaces so information never gets lost in chat noise:
* **📢 Official Announcements**: Read-only broadcasting space where authorized club organizers publish notices and meeting agendas.
* **💬 Community Discussion**: Real-time group chat for members to discuss ideas, share resources, and collaborate.
* **🚀 Project Rooms**: Dedicated team spaces for students developing club projects (e.g. hackathon teams, rover builds).
* **📅 Club Events & Workshops**: Scheduled activities, registrations, and venue details specific to the club.
* **👥 Member Directory**: Verified directory categorizing club presidents, coordinators, and active members.

### 2. 📅 Unified Campus Events & Digital Passes
* **Campus-Wide Event Calendar**: Browse workshops, fests, hackathons, and guest lectures across all college clubs.
* **1-Click Registration & Capacity Limits**: Real-time attendance caps prevent overbooking.
* **🎟️ Digital QR Attendance Pass**: Generates a secure, unique QR pass for every registered attendee to enable fast on-site check-in.

### 3. 🎓 Verified Student Identity
* **College Identity Card**: Student profiles show verified badges, academic department, study year, and student roll number.
* **Club Roster**: Displays a student's active clubs, leadership roles, and registered event passes in one place.

### 4. 🛡️ Role-Based Security & Permissions
Enforced strictly at the PostgreSQL database level using **Row Level Security (RLS)**:
* **College Administrators**: Oversee college settings and verify student organizations.
* **Club Presidents & Organizers**: Appoint leads, broadcast official notices, schedule events, and moderate discussions.
* **Club Members**: Chat, participate in discussions, register for workshops, and access resources.
* **Students**: Discover public club profiles, submit membership requests, and view the campus calendar.

---

## 🛠️ Technology Stack

* **Frontend**: React 18, TypeScript, Vite
* **UI & Styling**: Tailwind CSS, Radix UI primitives (`shadcn/ui`), Lucide Icons
* **Mobile Runtime**: Capacitor 8 (Android)
* **Backend & Database**: Supabase (PostgreSQL 15)
* **Realtime Engine**: Supabase Realtime (WebSockets)
* **Storage**: Supabase Storage (`posts`, `avatars` buckets)
* **CI/CD**: GitHub Actions automated Android APK compilation & releases

---

## 🗄️ Database Architecture

CampusConnect is backed by a relational PostgreSQL schema:

```
public.profiles
  ├── id (UUID, PK -> auth.users)
  ├── username, bio, avatar_url
  ├── department (Text)
  ├── year (Text)
  ├── student_id (Roll No)
  ├── college_role (student | faculty | college_admin)
  └── is_verified (Boolean)

public.clubs
  ├── id (UUID, PK)
  ├── name, slug, description, category
  ├── faculty_coordinator, status
  └── created_by (FK -> profiles.id)

public.club_memberships
  ├── id (UUID, PK)
  ├── club_id (FK -> clubs.id)
  ├── user_id (FK -> profiles.id)
  ├── role (president | organizer | member)
  └── status (active | pending | rejected)

public.club_channels
  ├── id (UUID, PK)
  ├── club_id (FK -> clubs.id)
  ├── name (announcements, general, project, events)
  └── type (announcements | general | project | events)

public.channel_messages
  ├── id (UUID, PK)
  ├── channel_id (FK -> club_channels.id)
  ├── sender_id (FK -> profiles.id)
  ├── content (Text), is_pinned (Boolean)
  └── created_at (Timestamp)

public.events
  ├── id (UUID, PK)
  ├── club_id (FK -> clubs.id)
  ├── title, description, venue, start_time, capacity
  └── is_published (Boolean)

public.event_registrations
  ├── id (UUID, PK)
  ├── event_id (FK -> events.id)
  ├── user_id (FK -> profiles.id)
  ├── qr_code_token (UUID token)
  └── status (registered | attended | cancelled)
```

---

## 🚀 Getting Started Locally

### Prerequisites
* [Node.js](https://nodejs.org/) (v18+)
* npm (v9+)

### Installation

```bash
# 1. Clone the repository
git clone https://github.com/MokuLakshithReddy/campus-connect.git

# 2. Navigate to project root
cd campus-connect

# 3. Install dependencies
npm install

# 4. Set up environment variables
cp .env.example .env
# Fill in VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY

# 5. Start the development server
npm run dev
```

### Building for Mobile (Android)

```bash
# Build the web bundle
npm run build

# Sync assets with Capacitor
npx cap sync android

# Open Android Studio to build APK
npx cap open android
```

---

## 📄 License

This project is licensed under the [MIT License](LICENSE).
