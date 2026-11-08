---
tags: [skill-creator]
max_turns: 20
timeout_seconds: 600
allowed_tools: [Read, Glob, Grep, Skill, Write, Edit, Bash]
---

we need to build our api's docker image for linux/amd64 on the microvm runners in this repo. the build peaks around 12GB ram and wants ~4 cores. what should runs-on be in .github/workflows/build.yml? just tell me the yaml and why
