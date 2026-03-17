# Security Policy

## Supported Versions

| Version | Supported          |
|---------|--------------------|
| 3.x     | ✅ Active support  |
| < 3.0   | ❌ No longer supported |

## Reporting a Vulnerability

If you discover a security vulnerability, please report it responsibly:

1. **Do NOT open a public issue**
2. Email **support@bridgesllm.com** with:
   - Description of the vulnerability
   - Steps to reproduce
   - Potential impact assessment
3. You'll receive an acknowledgment within 48 hours
4. We'll work with you on a fix and coordinated disclosure

## Security Measures

BridgesLLM Portal implements multiple layers of security:

- **Automatic HTTPS** via Caddy + Let's Encrypt
- **Sandboxed code execution** in isolated Docker containers
- **Token-based gateway authentication** (OpenClaw WebSocket protocol)
- **Parameterized database queries** via Prisma ORM
- **JWT authentication** with separate access/refresh tokens
- **CSP headers** configured via Helmet
- **Input validation** using Zod schemas
- **UFW firewall** configured during installation (only ports 22, 80, 443 exposed)
- **Mail server** locked to loopback interface

## Responsible Disclosure

We appreciate the security research community and will:
- Acknowledge your contribution in release notes (with permission)
- Not take legal action against good-faith security research
- Work to fix verified vulnerabilities within 7 days
