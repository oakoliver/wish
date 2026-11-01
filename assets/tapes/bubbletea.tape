# Render from the repo root: vhs assets/tapes/bubbletea.tape
Output "/Users/oliveiraantoniocc/Documents/projects/wish/assets/bubbletea.gif"

Set Shell bash
Set FontSize 16
Set Width 900
Set Height 420
Set Padding 24
Set Theme "Catppuccin Mocha"
Set TypingSpeed 40ms
Set Framerate 20

Hide
Type "export PS1='> ' && clear"
Enter
Type "mkdir -p /tmp/wish-demo && rm -f /tmp/wish-demo/id* && ssh-keygen -q -t ed25519 -N '' -f /tmp/wish-demo/id && printf 'Host localhost\n  IdentityFile /tmp/wish-demo/id\n  IdentitiesOnly yes\n  LogLevel ERROR\n' > /tmp/wish-demo/config && alias ssh='ssh -F /tmp/wish-demo/config'"
Enter
Type "bun examples/bubbletea.ts >/tmp/wish-demo/bubbletea.log 2>&1 & sleep 1.5 && clear"
Enter
Sleep 2s
Show

Type "ssh -p 23234 -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null localhost"
Sleep 300ms
Enter
Sleep 3s
Type "q"
Sleep 1.2s

Hide
Type "kill %1 2>/dev/null; rm -rf /tmp/wish-demo"
Enter
Sleep 300ms
