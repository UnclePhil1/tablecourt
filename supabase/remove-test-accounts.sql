-- Removes the two test accounts Claude made while checking online 1v1, and their matches.
delete from public.games
 where host_key  in ('w:pkdMCSMMj5F66jhsrumWUjqpujY9QsnB', 'w:Dz4fpKGV5fVHqSatXLFvuHLJnvaTBznd')
    or guest_key in ('w:pkdMCSMMj5F66jhsrumWUjqpujY9QsnB', 'w:Dz4fpKGV5fVHqSatXLFvuHLJnvaTBznd');
delete from public.wallet_players
 where wallet in ('pkdMCSMMj5F66jhsrumWUjqpujY9QsnB', 'Dz4fpKGV5fVHqSatXLFvuHLJnvaTBznd');
