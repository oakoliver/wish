# Render from the repo root: vhs assets/tapes/lobby.tape
# A background script (assets/tapes/bots.ts lobby) connects as ana and ben.
Output "/Users/oliveiraantoniocc/Documents/projects/wish/assets/lobby.gif"

Set Shell bash
Set FontSize 16
Set Width 1000
Set Height 560
Set Padding 24
Set Theme "Catppuccin Mocha"
Set TypingSpeed 40ms
Set Framerate 20

Hide
Type "export PS1='> ' && clear"
Enter
Type "mkdir -p /tmp/wish-demo && rm -f /tmp/wish-demo/id* && ssh-keygen -q -t ed25519 -N '' -f /tmp/wish-demo/id && printf 'Host localhost\n  IdentityFile /tmp/wish-demo/id\n  IdentitiesOnly yes\n  LogLevel ERROR\n' > /tmp/wish-demo/config && alias ssh='ssh -F /tmp/wish-demo/config'"
Enter
Type "bun examples/lobby.ts >/tmp/wish-demo/lobby.log 2>&1 & BOT_DELAY=7500 bun assets/tapes/bots.ts lobby >/dev/null 2>&1 & sleep 1.5 && clear"
Enter
Sleep 2s
Show

Type "ssh -p 23236 -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null alice@localhost"
Sleep 300ms
Enter
Sleep 5.2s

# ana is typing in another terminal: the member list shows it, then the message lands.
Type "@ana hi! this is all over SSH"
Sleep 400ms
Enter
Sleep 12.5s

# ben has come and gone; leave the room.
Ctrl+C
Sleep 1.2s

Hide
Type "kill %1 %2 2>/dev/null; rm -rf /tmp/wish-demo"
Enter
Sleep 300ms
