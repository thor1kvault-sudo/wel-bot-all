## FILES TO PUSH (All in this folder)

index.js        - Main bot code
package.json    - Dependencies
.env.example    - Token template (safe to push)
.gitignore      - Hides .env and node_modules
README.md       - Bot documentation
config.json     - Bot info

DO NOT PUSH:
.env            - Has your real token (auto-hidden by .gitignore)
node_modules/   - Auto-hidden by .gitignore


## STEP 1 - Create GitHub Repo

1. Go to: https://github.com/new
2. Fill in:
   - Repository name: welcome-bot
   - Visibility: Public
   - Do NOT add README, .gitignore, or license
3. Click Create repository
4. Copy your repo URL:
   https://github.com/YOUR_USERNAME/welcome-bot.git


## STEP 2 - Push Code

Open Git Bash inside this bot folder, run these one by one:

git init
git add .
git commit -m "multi-server welcome bot v2.0"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/welcome-bot.git
git push -u origin main

NOTE: Replace YOUR_USERNAME with your actual GitHub username!

When asked for password, use a Personal Access Token (NOT your real password):
Get one at: https://github.com/settings/tokens/new
Tick the "repo" checkbox, then Generate token, copy it.


## STEP 3 - Deploy on Render

1. Go to: https://render.com
2. Sign up / Log in with GitHub
3. Click: New then Web Service
4. Connect your welcome-bot repo
5. Set these options:

   Name:           welcome-bot
   Environment:    Node
   Build Command:  npm install
   Start Command:  npm start
   Instance Type:  Free

6. Scroll to "Environment Variables" then Add:

   Key:    DISCORD_TOKEN
   Value:  (paste your bot token here)

7. Click Create Web Service
8. Wait 2-3 minutes, then bot goes online!


## STEP 4 - Keep Bot Alive 24/7 (Free)

Render free tier sleeps after 15 mins with no traffic.
Fix this with UptimeRobot (free):

1. Go to: https://uptimerobot.com
2. Sign up free, then Add New Monitor
3. Fill in:
   - Monitor Type: HTTP(s)
   - Friendly Name: Welcome Bot
   - URL: https://YOUR-APP-NAME.onrender.com
   - Interval: Every 5 minutes
4. Click Create Monitor
Bot stays online 24/7!


## STEP 5 - Future Code Updates

Every time you change the code, push like this:

git add .
git commit -m "describe your change here"
git push

Render will auto-redeploy!


## RENDER SETTINGS QUICK REFERENCE

Setting         Value
-----------     -----------
Environment     Node
Build Command   npm install
Start Command   npm start
Instance Type   Free

Environment Variable:
Key   = DISCORD_TOKEN
Value = your_bot_token_here


## BOT SLASH COMMANDS (For Server Admins)

Once the bot is live, server admins run these in their server:

/welcomehelp       - See all commands
/setwelcome        - Set welcome channel
/setrules          - Set rules channel
/setroles          - Set roles channel
/setgeneral        - Set general channel
/setwelcomecolor   - Change embed color (e.g. #FF5733)
/setwelcometext    - Change greeting, subtitle, outro text
/welcomeconfig     - View current settings
/testwelcome       - Preview the welcome message
/resetwelcome      - Reset all settings to default
