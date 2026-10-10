export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  __InternalSupabase: {
    PostgrestVersion: "14.1"
  }
  public: {
    Tables: {
      clubs: {
        Row: {
          id: string
          name: string
          slug: string
          description: string | null
          category: string
          logo_url: string | null
          cover_url: string | null
          faculty_coordinator: string | null
          status: "active" | "pending_approval" | "inactive"
          created_by: string | null
          created_at: string
          updated_at: string
        }
        Insert: {
          id?: string
          name: string
          slug: string
          description?: string | null
          category?: string
          logo_url?: string | null
          cover_url?: string | null
          faculty_coordinator?: string | null
          status?: "active" | "pending_approval" | "inactive"
          created_by?: string | null
          created_at?: string
          updated_at?: string
        }
        Update: {
          id?: string
          name?: string
          slug?: string
          description?: string | null
          category?: string
          logo_url?: string | null
          cover_url?: string | null
          faculty_coordinator?: string | null
          status?: "active" | "pending_approval" | "inactive"
          created_by?: string | null
          created_at?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "clubs_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          }
        ]
      }
      club_memberships: {
        Row: {
          id: string
          club_id: string
          user_id: string
          role: "president" | "organizer" | "member"
          status: "active" | "pending" | "rejected" | "banned"
          joined_at: string
          created_at: string
        }
        Insert: {
          id?: string
          club_id: string
          user_id: string
          role?: "president" | "organizer" | "member"
          status?: "active" | "pending" | "rejected" | "banned"
          joined_at?: string
          created_at?: string
        }
        Update: {
          id?: string
          club_id?: string
          user_id?: string
          role?: "president" | "organizer" | "member"
          status?: "active" | "pending" | "rejected" | "banned"
          joined_at?: string
          created_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "club_memberships_club_id_fkey"
            columns: ["club_id"]
            isOneToOne: false
            referencedRelation: "clubs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "club_memberships_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          }
        ]
      }
      club_channels: {
        Row: {
          id: string
          club_id: string
          name: string
          type: "announcements" | "general" | "project" | "events"
          description: string | null
          is_private: boolean
          created_at: string
        }
        Insert: {
          id?: string
          club_id: string
          name: string
          type?: "announcements" | "general" | "project" | "events"
          description?: string | null
          is_private?: boolean
          created_at?: string
        }
        Update: {
          id?: string
          club_id?: string
          name?: string
          type?: "announcements" | "general" | "project" | "events"
          description?: string | null
          is_private?: boolean
          created_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "club_channels_club_id_fkey"
            columns: ["club_id"]
            isOneToOne: false
            referencedRelation: "clubs"
            referencedColumns: ["id"]
          }
        ]
      }
      channel_messages: {
        Row: {
          id: string
          channel_id: string
          sender_id: string
          content: string
          attachments: Json | null
          is_pinned: boolean
          created_at: string
        }
        Insert: {
          id?: string
          channel_id: string
          sender_id: string
          content: string
          attachments?: Json | null
          is_pinned?: boolean
          created_at?: string
        }
        Update: {
          id?: string
          channel_id?: string
          sender_id?: string
          content?: string
          attachments?: Json | null
          is_pinned?: boolean
          created_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "channel_messages_channel_id_fkey"
            columns: ["channel_id"]
            isOneToOne: false
            referencedRelation: "club_channels"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "channel_messages_sender_id_fkey"
            columns: ["sender_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          }
        ]
      }
      events: {
        Row: {
          id: string
          club_id: string
          title: string
          description: string | null
          poster_url: string | null
          venue: string
          start_time: string
          end_time: string | null
          capacity: number | null
          is_published: boolean
          created_by: string | null
          created_at: string
        }
        Insert: {
          id?: string
          club_id: string
          title: string
          description?: string | null
          poster_url?: string | null
          venue: string
          start_time: string
          end_time?: string | null
          capacity?: number | null
          is_published?: boolean
          created_by?: string | null
          created_at?: string
        }
        Update: {
          id?: string
          club_id?: string
          title?: string
          description?: string | null
          poster_url?: string | null
          venue?: string
          start_time?: string
          end_time?: string | null
          capacity?: number | null
          is_published?: boolean
          created_by?: string | null
          created_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "events_club_id_fkey"
            columns: ["club_id"]
            isOneToOne: false
            referencedRelation: "clubs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "events_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          }
        ]
      }
      event_registrations: {
        Row: {
          id: string
          event_id: string
          user_id: string
          status: "registered" | "waitlist" | "attended" | "cancelled"
          qr_code_token: string
          checked_in_at: string | null
          created_at: string
        }
        Insert: {
          id?: string
          event_id: string
          user_id: string
          status?: "registered" | "waitlist" | "attended" | "cancelled"
          qr_code_token?: string
          checked_in_at?: string | null
          created_at?: string
        }
        Update: {
          id?: string
          event_id?: string
          user_id?: string
          status?: "registered" | "waitlist" | "attended" | "cancelled"
          qr_code_token?: string
          checked_in_at?: string | null
          created_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "event_registrations_event_id_fkey"
            columns: ["event_id"]
            isOneToOne: false
            referencedRelation: "events"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "event_registrations_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          }
        ]
      }
      notifications: {
        Row: {
          id: string
          user_id: string
          type: string
          title: string
          message: string
          resource_type: string | null
          resource_id: string | null
          is_read: boolean
          created_at: string
        }
        Insert: {
          id?: string
          user_id: string
          type: string
          title: string
          message: string
          resource_type?: string | null
          resource_id?: string | null
          is_read?: boolean
          created_at?: string
        }
        Update: {
          id?: string
          user_id?: string
          type?: string
          title?: string
          message?: string
          resource_type?: string | null
          resource_id?: string | null
          is_read?: boolean
          created_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "notifications_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          }
        ]
      }
      profiles: {
        Row: {
          avatar_url: string | null
          bio: string | null
          college_role: "student" | "faculty" | "college_admin"
          created_at: string
          department: string | null
          id: string
          is_verified: boolean
          must_change_password: boolean
          student_id: string | null
          updated_at: string
          username: string
          year: string | null
        }
        Insert: {
          avatar_url?: string | null
          bio?: string | null
          college_role?: "student" | "faculty" | "college_admin"
          created_at?: string
          department?: string | null
          id: string
          is_verified?: boolean
          must_change_password?: boolean
          student_id?: string | null
          updated_at?: string
          username: string
          year?: string | null
        }
        Update: {
          avatar_url?: string | null
          bio?: string | null
          college_role?: "student" | "faculty" | "college_admin"
          created_at?: string
          department?: string | null
          id?: string
          is_verified?: boolean
          must_change_password?: boolean
          student_id?: string | null
          updated_at?: string
          username?: string
          year?: string | null
        }
        Relationships: []
      }
      comments: {
        Row: {
          content: string
          created_at: string
          id: string
          post_id: string
          user_id: string
        }
        Insert: {
          content: string
          created_at?: string
          id?: string
          post_id: string
          user_id: string
        }
        Update: {
          content?: string
          created_at?: string
          id?: string
          post_id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "comments_post_id_fkey"
            columns: ["post_id"]
            isOneToOne: false
            referencedRelation: "posts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "comments_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          }
        ]
      }
      conversations: {
        Row: {
          created_at: string
          id: string
          last_message_at: string
          user1_id: string
          user2_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          last_message_at?: string
          user1_id: string
          user2_id: string
        }
        Update: {
          created_at?: string
          id?: string
          last_message_at?: string
          user1_id?: string
          user2_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "conversations_user1_id_fkey"
            columns: ["user1_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "conversations_user2_id_fkey"
            columns: ["user2_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          }
        ]
      }
      followers: {
        Row: {
          created_at: string
          follower_id: string
          following_id: string
          id: string
        }
        Insert: {
          created_at?: string
          follower_id: string
          following_id: string
          id?: string
        }
        Update: {
          created_at?: string
          follower_id?: string
          following_id?: string
          id?: string
        }
        Relationships: [
          {
            foreignKeyName: "followers_follower_id_fkey"
            columns: ["follower_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "followers_following_id_fkey"
            columns: ["following_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          }
        ]
      }
      likes: {
        Row: {
          created_at: string
          id: string
          post_id: string
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          post_id: string
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          post_id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "likes_post_id_fkey"
            columns: ["post_id"]
            isOneToOne: false
            referencedRelation: "posts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "likes_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          }
        ]
      }
      messages: {
        Row: {
          content: string
          conversation_id: string
          created_at: string
          id: string
          read: boolean
          sender_id: string
        }
        Insert: {
          content: string
          conversation_id: string
          created_at?: string
          id?: string
          read?: boolean
          sender_id: string
        }
        Update: {
          content?: string
          conversation_id?: string
          created_at?: string
          id?: string
          read?: boolean
          sender_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "messages_conversation_id_fkey"
            columns: ["conversation_id"]
            isOneToOne: false
            referencedRelation: "conversations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "messages_sender_id_fkey"
            columns: ["sender_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          }
        ]
      }
      posts: {
        Row: {
          caption: string | null
          created_at: string
          id: string
          image_url: string
          user_id: string
        }
        Insert: {
          caption?: string | null
          created_at?: string
          id?: string
          image_url: string
          user_id: string
        }
        Update: {
          caption?: string | null
          created_at?: string
          id?: string
          image_url?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "posts_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          }
        ]
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      register_for_event: {
        Args: {
          p_event_id: string
        }
        Returns: Json
      }
      cancel_event_registration: {
        Args: {
          p_event_id: string
        }
        Returns: Json
      }
      check_in_event_attendee: {
        Args: {
          p_event_id: string
          p_qr_token: string
        }
        Returns: Json
      }
      approve_club_membership: {
        Args: {
          p_membership_id: string
        }
        Returns: Json
      }
      reject_club_membership: {
        Args: {
          p_membership_id: string
        }
        Returns: Json
      }
      appoint_club_organizer: {
        Args: {
          p_membership_id: string
        }
        Returns: Json
      }
      verify_student_account: {
        Args: {
          p_user_id: string
          p_is_verified: boolean
        }
        Returns: Json
      }
      complete_first_time_password_change: {
        Args: Record<PropertyKey, never>
        Returns: Json
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never
