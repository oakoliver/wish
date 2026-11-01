# Render from the repo root: vhs assets/tapes/arena.tape
# A background script (assets/tapes/bots.ts arena) logs in as the AI player.
Output "/Users/oliveiraantoniocc/Documents/projects/wish/assets/arena.gif"

Set Shell bash
Set FontSize 14
Set Width 1080
Set Height 600
Set Padding 20
Set Theme "Catppuccin Mocha"
Set TypingSpeed 40ms
Set Framerate 20

Hide
Type "export PS1='> ' && clear"
Enter
Type "mkdir -p /tmp/wish-demo && rm -f /tmp/wish-demo/id* && ssh-keygen -q -t ed25519 -N '' -f /tmp/wish-demo/id && printf 'Host localhost\n  IdentityFile /tmp/wish-demo/id\n  IdentitiesOnly yes\n  LogLevel ERROR\n' > /tmp/wish-demo/config && alias ssh='ssh -F /tmp/wish-demo/config'"
Enter
Type "bun examples/arena.ts >/tmp/wish-demo/arena.log 2>&1 & BOT_DELAY=1000 bun assets/tapes/bots.ts arena >/dev/null 2>&1 & sleep 1.5 && clear"
Enter
Sleep 2s
Show

Type "ssh -p 23237 -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null alice@localhost"
Sleep 300ms
Enter
Sleep 1.5s

# Play badly on purpose: hard-drop pieces until the well fills up.
Left
Sleep 200ms
Space
Sleep 400ms
Right
Right
Sleep 200ms
Space
Sleep 400ms
Up
Sleep 200ms
Space
Sleep 400ms
Left
Left
Left
Sleep 200ms
Space
Sleep 400ms
Space
Sleep 400ms
Space
Sleep 400ms
Space
Sleep 400ms
Space
Sleep 400ms
Space
Sleep 400ms
Space
Sleep 400ms
Space
Sleep 400ms
Space
Sleep 400ms
Space
Sleep 400ms
Space
Sleep 400ms
Space
Sleep 3s

# The game is over and the score is on the board, next to the AI still playing.
Type "q"
Sleep 1s

Hide
Type "kill %1 %2 2>/dev/null; rm -rf /tmp/wish-demo"
Enter
Sleep 300ms
