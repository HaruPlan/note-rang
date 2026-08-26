Drop a YouTube link into a note and it turns into a player you can watch right there, instead of a plain link.

## How to use

Put a link inside a `youtube` code block like this, and it turns into a player once the cursor leaves the block:

    ```youtube
    https://www.youtube.com/watch?v=dQw4w9WgXcQ
    ```

- Supports `watch?v=…`, `youtu.be/…`, and `shorts/…` links.
- The player only loads when it's visible on screen, so it stays lightweight. The file itself still stores just the link text.
- Playback happens on a more privacy-friendly domain (youtube-nocookie.com).

> 💡 While the cursor is inside the block, the link shows as plain text; once it leaves, it becomes a player. To edit the link again, move the cursor back inside the block.
