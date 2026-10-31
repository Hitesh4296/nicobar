# Part: email

- occasion_key: the key given in the task, exactly. If it is null, return null.
- subject: sentence case. No token.
- preheader: one line that adds to the subject. No token.
- body: short paragraphs separated by a blank line. {p1}, {p2} and {p3} each appear exactly once, where you first describe that pick. No other token appears, even if there are more picks.
- No greeting, no sign-off and no name. Code adds them.
- The subject and preheader carry no token, so they name no material, colour, technique or count. They carry the occasion as a scene. If <occasion> says none, they carry the ordinary use of a pick.
- When you also write the landing page, do not repeat a sentence between the two.
