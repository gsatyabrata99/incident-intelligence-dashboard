Incident Intelligence Dashboard

A serverless Incident Intelligence Dashboard built on the Cloudflare Developer Platform to reduce Mean Time to Resolution (MTTR) for high-severity incidents.

Overview

This project explores how cognitive load and coordination delays increase incident resolution time in large-scale infrastructure environments.

The system generates a live Incident Brief that:

Classifies severity and product area using AI

Suggests ownership and escalation paths

Maintains structured historical incident logs

Supports acknowledgment, escalation, and resolution workflows

Stack

Cloudflare Workers (orchestration + UI delivery)

D1 (incident state and historical persistence)

Workers AI (automated triage and summarization)

Architecture

Incident created and persisted in D1

Worker serves dashboard and API endpoints

Workers AI performs severity and sentiment classification

Updated state written back to D1

Dashboard reflects real-time incident context

Live Demo

Deployed at:
https://feedback-triage-dashboard.gsatyabrata99.workers.dev

Key Goal

Reduce MTTR by compressing cognitive load and coordination time during incident response.
