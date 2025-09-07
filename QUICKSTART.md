# Quick Start Guide - MCP SSH Manager

Get up and running in 5 minutes! 🚀

## 1️⃣ Clone & Install (1 minute)

```bash
git clone https://github.com/bvisible/mcp-ssh-manager.git
cd mcp-ssh-manager
npm install
cd cli && ./install.sh
```

## 2️⃣ Add Your First Server (2 minutes)

```bash
# Launch interactive menu
ssh-manager
```

Choose: `1) Server Management` → `1) Add New Server`

Enter:
- Name: `myserver`
- Host: `your.server.com`
- Username: `yourusername`
- Port: `22`
- Choose authentication method (SSH key recommended)

## 3️⃣ Install to Claude Code (1 minute)

```bash
claude mcp add ssh-manager node $(pwd)/src/index.js
```

## 4️⃣ Test It! (1 minute)

In Claude Code:
```bash
claude
```

Try these commands:
```
"List my SSH servers"
"Execute 'hostname' on myserver"
"Run 'ls -la' on myserver"
```

## 🎉 That's it!

You're now connected to your server through Claude Code!

## 📝 Common Commands

```bash
ssh-manager                    # Interactive menu
ssh-manager server list        # List servers
ssh-manager ssh myserver       # Quick SSH
ssh-manager server test        # Test connections
ssh-manager sync push myserver ./app /var/www/  # Upload files
```

## 💡 Pro Tips

1. **Set environment variable** in `~/.bashrc` or `~/.zshrc`:
   ```bash
   export SSH_MANAGER_ENV="/path/to/your/.env"
   ```

2. **Create shortcuts**:
   ```bash
   alias ssm="ssh-manager"
   alias ssm-list="ssh-manager server list"
   ```

Need help? Run `ssh-manager --help`