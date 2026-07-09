-- Restrict product image storage access to each user's own folder.
-- Public object URLs keep working because the bucket itself remains public.

drop policy if exists "product-images: public read" on storage.objects;
drop policy if exists "product-images: auth upload" on storage.objects;
drop policy if exists "product-images: auth delete" on storage.objects;

create policy "product-images: auth select own folder"
on storage.objects
for select
to authenticated
using (
  bucket_id = 'product-images'
  and (storage.foldername(name))[1] = 'products'
  and (storage.foldername(name))[2] = ((select auth.uid())::text)
);

create policy "product-images: auth insert own folder"
on storage.objects
for insert
to authenticated
with check (
  bucket_id = 'product-images'
  and (storage.foldername(name))[1] = 'products'
  and (storage.foldername(name))[2] = ((select auth.uid())::text)
);

create policy "product-images: auth update own folder"
on storage.objects
for update
to authenticated
using (
  bucket_id = 'product-images'
  and (storage.foldername(name))[1] = 'products'
  and (storage.foldername(name))[2] = ((select auth.uid())::text)
)
with check (
  bucket_id = 'product-images'
  and (storage.foldername(name))[1] = 'products'
  and (storage.foldername(name))[2] = ((select auth.uid())::text)
);

create policy "product-images: auth delete own folder"
on storage.objects
for delete
to authenticated
using (
  bucket_id = 'product-images'
  and (storage.foldername(name))[1] = 'products'
  and (storage.foldername(name))[2] = ((select auth.uid())::text)
);
