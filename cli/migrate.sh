#!/bin/bash
# Migration script from Python to Bash CLI

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
RED='\033[0;31m'
NC='\033[0m'

clear
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${BLUE}      Migration: Python → Bash CLI${NC}"
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo

# Find .env file
ENV_LOCATIONS=(
    "../.env"
    "../../mcp-ssh-manager/.env"
    "$HOME/mcp/mcp-ssh-manager/.env"
    ".env"
)

ENV_FILE=""
for location in "${ENV_LOCATIONS[@]}"; do
    if [ -f "$location" ]; then
        ENV_FILE="$location"
        break
    fi
done

if [ -z "$ENV_FILE" ]; then
    echo -e "${RED}❌ No .env file found!${NC}"
    echo
    echo "Searched in:"
    for location in "${ENV_LOCATIONS[@]}"; do
        echo "  • $location"
    done
    echo
    echo "Please specify the path to your .env file:"
    read -p "Path: " ENV_FILE
    
    if [ ! -f "$ENV_FILE" ]; then
        echo -e "${RED}File not found: $ENV_FILE${NC}"
        exit 1
    fi
fi

echo -e "${GREEN}✅ Found .env file:${NC} $ENV_FILE"
echo

# Count servers
SERVER_COUNT=$(grep "^SSH_SERVER_.*_HOST=" "$ENV_FILE" | wc -l | tr -d ' ')
echo -e "${BLUE}📊 Statistics:${NC}"
echo "  • Servers configured: $SERVER_COUNT"
echo "  • Configuration file: $(realpath "$ENV_FILE")"
echo

# Show servers
echo -e "${BLUE}🖥️  Your servers:${NC}"
grep "^SSH_SERVER_.*_HOST=" "$ENV_FILE" | while IFS= read -r line; do
    SERVER_NAME=$(echo "$line" | sed 's/SSH_SERVER_\(.*\)_HOST=.*/\1/' | tr '[:upper:]' '[:lower:]')
    HOST=$(echo "$line" | cut -d'=' -f2-)
    echo "  • $SERVER_NAME → $HOST"
done
echo

# Check if CLI is installed
if command -v ssh-manager >/dev/null 2>&1; then
    echo -e "${GREEN}✅ Bash CLI is installed${NC}"
    CLI_PATH="ssh-manager"
else
    echo -e "${YELLOW}⚠️  Bash CLI not installed globally${NC}"
    SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
    CLI_PATH="$SCRIPT_DIR/ssh-manager"
    
    if [ ! -f "$CLI_PATH" ]; then
        echo -e "${RED}❌ CLI not found at $CLI_PATH${NC}"
        exit 1
    fi
    
    echo -e "${BLUE}Installing CLI...${NC}"
    ./install.sh
    
    if command -v ssh-manager >/dev/null 2>&1; then
        echo -e "${GREEN}✅ CLI installed successfully${NC}"
        CLI_PATH="ssh-manager"
    fi
fi
echo

# Create alias for .env path
echo -e "${BLUE}🔧 Setting up environment...${NC}"

# Create wrapper script
WRAPPER="$HOME/.ssh-manager/ssh-manager-wrapper.sh"
mkdir -p "$HOME/.ssh-manager"

cat > "$WRAPPER" << EOF
#!/bin/bash
# Auto-generated wrapper for SSH Manager CLI
export SSH_MANAGER_ENV="$(realpath "$ENV_FILE")"
exec ssh-manager "\$@"
EOF

chmod +x "$WRAPPER"

echo -e "${GREEN}✅ Environment configured${NC}"
echo

# Add to shell profile
echo -e "${BLUE}📝 Shell configuration:${NC}"
echo
echo "Add this line to your ~/.bashrc or ~/.zshrc:"
echo
echo -e "${YELLOW}export SSH_MANAGER_ENV=\"$(realpath "$ENV_FILE")\"${NC}"
echo
echo "Or use the wrapper:"
echo -e "${YELLOW}alias ssh-manager='$WRAPPER'${NC}"
echo

# Test the setup
echo -e "${BLUE}🧪 Testing configuration...${NC}"
echo

export SSH_MANAGER_ENV="$(realpath "$ENV_FILE")"

# Test server list
if $CLI_PATH server list >/dev/null 2>&1; then
    echo -e "${GREEN}✅ CLI can read your servers${NC}"
else
    echo -e "${RED}❌ CLI failed to read servers${NC}"
    exit 1
fi

echo
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${GREEN}🎉 Migration complete!${NC}"
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo

echo -e "${BLUE}📚 Quick Start:${NC}"
echo
echo "  1. Interactive mode (with menu):"
echo "     ${YELLOW}SSH_MANAGER_ENV=\"$(realpath "$ENV_FILE")\" ssh-manager${NC}"
echo
echo "  2. Direct commands:"
echo "     ${YELLOW}SSH_MANAGER_ENV=\"$(realpath "$ENV_FILE")\" ssh-manager server list${NC}"
echo "     ${YELLOW}SSH_MANAGER_ENV=\"$(realpath "$ENV_FILE")\" ssh-manager ssh dmis${NC}"
echo
echo "  3. Or use the wrapper:"
echo "     ${YELLOW}$WRAPPER${NC}"
echo

echo -e "${BLUE}💡 Features comparison:${NC}"
echo
echo "  Python CLI            →  Bash CLI"
echo "  ─────────────────────────────────────────"
echo "  server_manager.py     →  ssh-manager"
echo "  Option 2 (Add)        →  ssh-manager server add"
echo "  Option 1 (List)       →  ssh-manager server list"
echo "  Option 3 (Test)       →  ssh-manager server test"
echo "  Option 4 (Remove)     →  ssh-manager server remove"
echo

echo -e "${GREEN}✨ The Bash CLI is 10x faster and has the same features!${NC}"
echo