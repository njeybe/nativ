# UI/UX Specifications & Layout Design

## 1. Design System & Tokens
- **Theme:** Dark Mode / High Contrast / Tailored Palette
- **Typography:** Modern Sans-Serif (e.g. Inter, Outfit)
- **Primary Color:** `#3b82f6` (Accent Indigo/Blue)
- **Background:** `#0f172a` (Deep Slate / Dark)
- **Surface / Cards:** `#1e293b` with subtle 1px border (`#334155`)
- **Text Primary:** `#f8fafc`
- **Text Muted:** `#94a3b8`
- **Border Radius:** `8px` (standard), `12px` (cards/modals)

## 2. Layout Structure & Viewport
- **Container Max-Width:** `1280px`
- **Navigation:** Top Header / Side Navigation with active indicators
- **Grid / Flex Layouts:** Responsive 12-column or flex gap-based layouts

## 3. Component Hierarchy
```
MainApplication
├── AppHeader (Logo, Navigation Links, User Profile / Status)
├── Workspace / MainContent
│   ├── BreadcrumbNavigation
│   ├── ViewHeader (Title, Action Buttons)
│   └── ContentView (Data Tables, Forms, or Cards)
└── AppFooter / NotificationToastContainer
```

## 4. Interaction States & Transitions
| State | Visual Requirement |
| :--- | :--- |
| **Default** | Clean borders, clear typography, crisp iconography |
| **Hover** | Subtle lift (`transform: translateY(-2px)`), glow border |
| **Loading** | Skeleton shimmer or spinner, disabled submit buttons |
| **Empty** | Helpful illustration, clear explanation, primary CTA button |
| **Error** | Red accent banner (`#ef4444`), descriptive troubleshooting message |

## 5. Accessibility & Responsiveness
- All interactive controls have visible focus rings and accessible labels (`aria-label`).
- Mobile breakpoint (`< 768px`) gracefully stacks side-by-side components.
