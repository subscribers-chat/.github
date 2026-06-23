<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="./assets/brand/horizontal-inline/dark.svg">
  <source media="(prefers-color-scheme: light)" srcset="./assets/brand/horizontal-inline/light.svg">
  <img alt="subscribers.chat" src="./assets/brand/horizontal-inline/light.svg" height="56">
</picture>

<br><br>

![Currently Under Development](https://img.shields.io/badge/Currently_Under_Development-FF6B00?style=flat-square)
![Solo Developer](https://img.shields.io/badge/Solo_Developer-1-8A2BE2?style=flat-square&logo=github&logoColor=white)
<img alt="Philippines" src="https://flagcdn.com/24x18/ph.png" height="18">

</div>

> My attempt at building a fast and reliable application with zero-knowledge, end-to-end encrypted chat and industry-specific features.

### Backend
![Java 25](https://img.shields.io/badge/Java_25-ED8B00?style=flat-square&logo=openjdk&logoColor=white)
![Spring Boot 4](https://img.shields.io/badge/Spring_Boot_4-6DB33F?style=flat-square&logo=springboot&logoColor=white)
![Spring Security](https://img.shields.io/badge/Spring_Security-6DB33F?style=flat-square&logo=springsecurity&logoColor=white)
![Spring Modulith](https://img.shields.io/badge/Spring_Modulith-6DB33F?style=flat-square&logo=spring&logoColor=white)
![Hibernate](https://img.shields.io/badge/Hibernate-59666C?style=flat-square&logo=hibernate&logoColor=white)
![Flyway](https://img.shields.io/badge/Flyway-CC0200?style=flat-square&logo=flyway&logoColor=white)
![PostgreSQL](https://img.shields.io/badge/PostgreSQL-4169E1?style=flat-square&logo=postgresql&logoColor=white)
![Maven](https://img.shields.io/badge/Maven-C71A36?style=flat-square&logo=apachemaven&logoColor=white)

### Messaging
![NATS JetStream](https://img.shields.io/badge/NATS_JetStream-27AAE1?style=flat-square&logo=natsdotio&logoColor=white)
![Protobuf](https://img.shields.io/badge/Protobuf-0064A5?style=flat-square&logo=protobuf&logoColor=white)
![Go](https://img.shields.io/badge/Go_1.26-00ADD8?style=flat-square&logo=go&logoColor=white)

### Frontend
![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?style=flat-square&logo=typescript&logoColor=white)
![React 19](https://img.shields.io/badge/React_19-61DAFB?style=flat-square&logo=react&logoColor=black)
![TanStack](https://img.shields.io/badge/TanStack-FF4154?style=flat-square&logo=reactquery&logoColor=white)
![Vite](https://img.shields.io/badge/Vite-646CFF?style=flat-square&logo=vite&logoColor=white)
![Tailwind CSS](https://img.shields.io/badge/Tailwind_v4-06B6D4?style=flat-square&logo=tailwindcss&logoColor=white)
![Bun](https://img.shields.io/badge/Bun-000000?style=flat-square&logo=bun&logoColor=white)
![Turborepo](https://img.shields.io/badge/Turborepo-EF4444?style=flat-square&logo=turborepo&logoColor=white)

### Desktop
![Rust](https://img.shields.io/badge/Rust-000000?style=flat-square&logo=rust&logoColor=white)
![Tauri v2](https://img.shields.io/badge/Tauri_v2-24C8DB?style=flat-square&logo=tauri&logoColor=white)
![ONNX](https://img.shields.io/badge/ONNX_Runtime-005CED?style=flat-square&logo=onnx&logoColor=white)
![FFmpeg](https://img.shields.io/badge/FFmpeg-007808?style=flat-square&logo=ffmpeg&logoColor=white)

---

### Topology

A NATS supercluster: three regional clusters (3 nodes each, full-mesh routes),
linked region-to-region by gateways, fronted by Cloudflare. Clients reach the
nearest region over WebSocket; the desktop app runs an embedded leaf node.

```mermaid
flowchart TB
    desktop["🖥️ Tauri desktop<br/>(embedded leaf)"]
    browser["🌐 Browser (wss)"]
    backend["⚙️ Spring Boot services"]
    auth["🔑 Spring Authorization Server<br/>(OAuth2 · NATS auth-callout)"]

    edge{{"☁️ Cloudflare edge"}}

    desktop --> edge
    browser --> edge
    backend --> edge

    edge -->|japan-1| JP
    edge -->|au| AU
    edge -->|singapore-1| SG

    subgraph JP["🇯🇵 japan"]
        direction LR
        j1((n1)) --- j2((n2)) --- j3((n3)) --- j1
    end
    subgraph AU["🇦🇺 australia"]
        direction LR
        a1((n1)) --- a2((n2)) --- a3((n3)) --- a1
    end
    subgraph SG["🇸🇬 singapore"]
        direction LR
        s1((n1)) --- s2((n2)) --- s3((n3)) --- s1
    end

    JP <==>|gateway| AU
    AU <==>|gateway| SG
    SG <==>|gateway| JP

    auth -.->|verifies tokens| edge

    classDef edge fill:#F38020,stroke:#fff,stroke-width:2px,color:#fff;
    classDef region fill:#0d2840,stroke:#27AAE1,color:#e6edf3;
    classDef cli fill:#161b22,stroke:#8b949e,color:#e6edf3;
    classDef node fill:#10302a,stroke:#3fb950,color:#3fb950;

    class edge edge;
    class JP,AU,SG region;
    class desktop,browser,backend,auth cli;
    class j1,j2,j3,a1,a2,a3,s1,s2,s3 node;
```

### Live status

![mesh](https://img.shields.io/endpoint?url=https%3A%2F%2Fstatus-badges.joshuagarrysalcedo.workers.dev%2Fmesh&style=flat-square)
![nats](https://img.shields.io/endpoint?url=https%3A%2F%2Fstatus-badges.joshuagarrysalcedo.workers.dev%2Fnats&style=flat-square)
![jenkins](https://img.shields.io/endpoint?url=https%3A%2F%2Fstatus-badges.joshuagarrysalcedo.workers.dev%2Fjenkins&style=flat-square&logo=jenkins&logoColor=white)
![nexus](https://img.shields.io/endpoint?url=https%3A%2F%2Fstatus-badges.joshuagarrysalcedo.workers.dev%2Fnexus&style=flat-square&logo=sonatype&logoColor=white)

### Organization at a glance

<!-- start organization badges -->
<!-- end organization badges -->

---

<sub>Working on: OAuth2/OIDC auth · transactional outbox → JetStream · RFC 8252 native desktop auth · a Rust media pipeline</sub>
