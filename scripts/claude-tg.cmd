@echo off
REM Start Claude Code with the telegram-bridge channel enabled: replies you send
REM from Telegram (swipe-reply on a message from this session) are pushed
REM straight into the session instead of waiting for telegram_wait_reply.
REM
REM Claude Code shows a one-screen "development channels" confirmation at
REM startup during the research preview; select "I am using this for local
REM development". Any extra arguments are passed through to claude.
claude --dangerously-load-development-channels server:telegram-bridge %*
